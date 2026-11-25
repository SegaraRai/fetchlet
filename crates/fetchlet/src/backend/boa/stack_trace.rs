//! Boa's call stack for V8's stack trace API.
//!
//! Boa 0.22 has no `Error.captureStackTrace`. This installs
//! `__fetchletStackFrames`, which js-src/stack-trace.ts turns into it; the
//! script removes the global. The optional function is matched by identity
//! of its code, as V8 matches the function, so closures made from the same
//! code match each other.

use boa_engine::builtins::function::OrdinaryFunction;
use boa_engine::object::builtins::JsArray;
use boa_engine::vm::{CodeBlock, SourcePath};
use boa_engine::{Context, JsArgs, JsResult, JsString, JsValue, NativeFunction, js_string};

pub(super) fn install(context: &mut Context) -> JsResult<()> {
    context.register_global_callable(
        js_string!("__fetchletStackFrames"),
        2,
        NativeFunction::from_fn_ptr(stack_frames),
    )
}

/// `__fetchletStackFrames(skipThrough, limit)`: the frames below the
/// caller, most recent first, as `[functionName, fileName, line, column,
/// isEval]`. With a function, the frames up to and including its most
/// recent call are left out, and none remain when it is not on the stack.
fn stack_frames(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let limit = args.get_or_undefined(1).to_length(context)?;
    // A native function runs without a frame of its own, so the most recent
    // frame is its caller's, which the caller leaves out.
    let mut frames: Vec<_> = context
        .stack_trace()
        .skip(1)
        .map(|frame| {
            (
                std::ptr::from_ref::<CodeBlock>(frame.code_block()),
                frame.position(),
            )
        })
        .collect();
    if let Some(function) = args.get_or_undefined(0).as_object() {
        let code = function
            .downcast_ref::<OrdinaryFunction>()
            .map(|function| std::ptr::from_ref(function.codeblock()));
        let call = code.and_then(|code| frames.iter().position(|(frame, _)| *frame == code));
        match call {
            Some(index) => {
                frames.drain(..=index);
            }
            None => frames.clear(),
        }
    }
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let frames: Vec<JsValue> = frames
        .into_iter()
        .take(limit)
        .map(|(_, location)| {
            let name = location.function_name.to_std_string_escaped();
            // Boa names a script's top level `<main>`; V8 gives it no name.
            let name = if name.is_empty() || name == "<main>" {
                JsValue::null()
            } else {
                JsString::from(name).into()
            };
            let file = match &location.path {
                SourcePath::Path(path) => JsString::from(path.display().to_string()).into(),
                _ => JsValue::null(),
            };
            let (line, column) = match location.position {
                Some(position) => (
                    JsValue::from(position.line_number()),
                    JsValue::from(position.column_number()),
                ),
                None => (JsValue::null(), JsValue::null()),
            };
            let is_eval = matches!(location.path, SourcePath::Eval);
            JsArray::from_iter([name, file, line, column, is_eval.into()], context).into()
        })
        .collect();
    Ok(JsArray::from_iter(frames, context).into())
}
