mod args;
mod error;
mod functions;
mod request;
mod response;

pub use error::FunctionError;
pub use functions::{FunctionFuture, Functions};
pub use request::FunctionRequest;
pub use response::FunctionResponse;

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use functions::Method;
