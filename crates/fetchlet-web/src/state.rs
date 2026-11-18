/// Web API state that belongs to one invocation, such as open compression
/// streams. The embedder creates it when an invocation begins and drops it
/// when the invocation ends, which releases everything it holds.
#[derive(Default)]
pub struct WebState {
    #[cfg(feature = "compression")]
    pub(crate) codecs: crate::compression::Codecs,
}
