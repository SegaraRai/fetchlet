//! ArrayBuffer transfer for Boa builds without its `experimental` feature.
//!
//! Boa 0.22 implements `ArrayBuffer.prototype.transfer`, `transferToFixedLength`
//! and `detached` (ES2024) only behind `experimental`, which also enables
//! unrelated proposals. Web Streams byte sources and `structuredClone` with a
//! transfer list need them to detach buffers, so this backend installs them
//! when the engine lacks them.
//!
//! Limitation: a resizable buffer transfers to a fixed-length buffer.

use boa_engine::object::FunctionObjectBuilder;
use boa_engine::object::builtins::{AlignedVec, JsArrayBuffer};
use boa_engine::property::PropertyDescriptor;
use boa_engine::{
    Context, JsArgs, JsNativeError, JsResult, JsString, JsValue, NativeFunction, js_string,
};

/// Alignment of Boa's ArrayBuffer data blocks.
const BLOCK_ALIGNMENT: usize = 64;

pub(super) fn install(context: &mut Context) -> JsResult<()> {
    let prototype = context
        .intrinsics()
        .constructors()
        .array_buffer()
        .prototype();
    if prototype.has_own_property(js_string!("transfer"), context)? {
        return Ok(());
    }

    let methods: [(JsString, NativeFunction); 2] = [
        (
            js_string!("transfer"),
            NativeFunction::from_fn_ptr(transfer),
        ),
        (
            js_string!("transferToFixedLength"),
            NativeFunction::from_fn_ptr(transfer),
        ),
    ];
    for (name, function) in methods {
        let function = FunctionObjectBuilder::new(context.realm(), function)
            .name(name.clone())
            .length(0)
            .constructor(false)
            .build();
        prototype.define_property_or_throw(
            name,
            PropertyDescriptor::builder()
                .value(function)
                .writable(true)
                .enumerable(false)
                .configurable(true),
            context,
        )?;
    }

    let getter = FunctionObjectBuilder::new(context.realm(), NativeFunction::from_fn_ptr(detached))
        .name(js_string!("get detached"))
        .length(0)
        .constructor(false)
        .build();
    prototype.define_property_or_throw(
        js_string!("detached"),
        PropertyDescriptor::builder()
            .get(getter)
            .enumerable(false)
            .configurable(true),
        context,
    )?;
    Ok(())
}

fn this_buffer(this: &JsValue, method: &str) -> JsResult<JsArrayBuffer> {
    this.as_object()
        .and_then(|object| JsArrayBuffer::from_object(object.clone()).ok())
        .ok_or_else(|| {
            JsNativeError::typ()
                .with_message(format!(
                    "{method} called on an object that is not an ArrayBuffer"
                ))
                .into()
        })
}

/// ArrayBufferCopyAndDetach (ES2024 §25.1.3.3) for fixed-length results.
fn transfer(this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let buffer = this_buffer(this, "ArrayBuffer.prototype.transfer")?;
    let length = match args.get_or_undefined(0) {
        length if length.is_undefined() => buffer.byte_length(),
        length => usize::try_from(length.to_index(context)?).map_err(|_| {
            JsNativeError::range().with_message("ArrayBuffer transfer length is too large")
        })?,
    };
    let data = buffer.detach(&JsValue::undefined())?;
    let copied = data.len().min(length);
    let block = AlignedVec::from_iter(
        BLOCK_ALIGNMENT,
        data.iter()
            .take(copied)
            .copied()
            .chain(std::iter::repeat_n(0, length - copied)),
    );
    Ok(JsArrayBuffer::from_byte_block(block, context)?.into())
}

fn detached(this: &JsValue, _: &[JsValue], _: &mut Context) -> JsResult<JsValue> {
    let buffer = this_buffer(this, "get ArrayBuffer.prototype.detached")?;
    Ok(buffer.data().is_none().into())
}
