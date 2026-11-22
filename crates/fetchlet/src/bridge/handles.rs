use super::body_source::BodySource;
use super::channels::OpenChannel;
use crate::{Error, Result};

/// Bits of a handle that index its slot. A handle packs a slot and that
/// slot's generation below 2^53, which a JavaScript number carries exactly;
/// 20 bits leave 33 for the generation.
const SLOT_BITS: u32 = 20;
/// Slots one invocation can hold at once, from the packing above.
const MAX_SLOTS: usize = 1 << SLOT_BITS;
/// The last generation a slot takes before it is retired.
const MAX_GENERATION: u64 = (1 << (53 - SLOT_BITS)) - 1;

/// What a handle names, of one of the kinds the bridge lends JavaScript.
pub(super) enum Resource {
    /// A Rust body that JavaScript reads on demand.
    Body(BodySource),
    /// JavaScript's end of a channel, such as an accepted WebSocket.
    Channel(Box<OpenChannel>),
}

struct Slot {
    generation: u64,
    resource: Option<Resource>,
}

/// The resources JavaScript reaches by number in the current invocation.
///
/// A handle is a slot index and the slot's generation. Releasing a slot
/// increments its generation, so an identifier JavaScript kept names nothing
/// rather than a newer resource. The slots outlive the invocation: its end
/// releases every entry, so no identifier from an earlier invocation
/// resolves in a later one. A slot whose generation runs out is never
/// reused.
#[derive(Default)]
pub(super) struct Handles {
    slots: Vec<Slot>,
    free: Vec<usize>,
    channels: usize,
}

impl Handles {
    /// Enter a resource; the handle is what JavaScript receives.
    pub fn insert(&mut self, resource: Resource) -> Result<u64> {
        let index = match self.free.pop() {
            Some(index) => index,
            None if self.slots.len() < MAX_SLOTS => {
                self.slots.push(Slot {
                    generation: 1,
                    resource: None,
                });
                self.slots.len() - 1
            }
            None => return Err(Error::LimitExceeded("open handles")),
        };
        if matches!(resource, Resource::Channel(_)) {
            self.channels += 1;
        }
        let slot = &mut self.slots[index];
        slot.resource = Some(resource);
        Ok(slot.generation << SLOT_BITS | index as u64)
    }

    fn slot(&mut self, handle: u64) -> Option<&mut Slot> {
        let index = (handle & (MAX_SLOTS as u64 - 1)) as usize;
        let generation = handle >> SLOT_BITS;
        self.slots
            .get_mut(index)
            .filter(|slot| slot.generation == generation && slot.resource.is_some())
    }

    pub fn body_mut(&mut self, handle: u64) -> Option<&mut BodySource> {
        match self.slot(handle)?.resource.as_mut()? {
            Resource::Body(body) => Some(body),
            Resource::Channel(_) => None,
        }
    }

    pub fn channel_mut(&mut self, handle: u64) -> Option<&mut OpenChannel> {
        match self.slot(handle)?.resource.as_mut()? {
            Resource::Channel(channel) => Some(channel),
            Resource::Body(_) => None,
        }
    }

    pub fn has_channels(&self) -> bool {
        self.channels > 0
    }

    /// The open channels and their handles.
    pub fn channels_mut(&mut self) -> impl Iterator<Item = (u64, &mut OpenChannel)> {
        let remaining = self.channels;
        self.slots
            .iter_mut()
            .enumerate()
            .filter_map(|(index, slot)| match slot.resource.as_mut() {
                Some(Resource::Channel(channel)) => {
                    Some((slot.generation << SLOT_BITS | index as u64, &mut **channel))
                }
                _ => None,
            })
            .take(remaining)
    }

    /// Release the body `handle` names, dropping it, which cancels its
    /// producer. A handle of another kind or of a released body is ignored,
    /// so release is idempotent.
    pub fn release_body(&mut self, handle: u64) {
        if self.body_mut(handle).is_some() {
            self.release(handle);
        }
    }

    pub fn release_channel(&mut self, handle: u64) {
        if self.channel_mut(handle).is_some() {
            self.release(handle);
        }
    }

    fn release(&mut self, handle: u64) {
        let index = (handle & (MAX_SLOTS as u64 - 1)) as usize;
        let Some(slot) = self.slots.get_mut(index) else {
            return;
        };
        let Some(resource) = slot.resource.take() else {
            return;
        };
        if matches!(resource, Resource::Channel(_)) {
            self.channels -= 1;
        }
        drop(resource);
        if slot.generation < MAX_GENERATION {
            slot.generation += 1;
            self.free.push(index);
        }
    }

    /// Release every entry, as the end of an invocation does.
    pub fn release_all(&mut self) {
        for index in 0..self.slots.len() {
            let slot = &self.slots[index];
            if slot.resource.is_some() {
                self.release(slot.generation << SLOT_BITS | index as u64);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Body;

    fn body() -> Resource {
        Resource::Body(BodySource::new(Body::empty(), None, "request body bytes"))
    }

    #[test]
    fn a_released_handle_names_nothing_after_its_slot_is_reused() {
        let mut handles = Handles::default();
        let first = handles.insert(body()).unwrap();
        handles.release_body(first);
        let second = handles.insert(body()).unwrap();
        assert_ne!(first, second);
        assert!(handles.body_mut(first).is_none());
        assert!(handles.body_mut(second).is_some());
        // Release is idempotent, and a stale handle releases nothing.
        handles.release_body(first);
        assert!(handles.body_mut(second).is_some());
    }

    #[test]
    fn handles_of_another_kind_or_out_of_range_name_nothing() {
        let mut handles = Handles::default();
        let handle = handles.insert(body()).unwrap();
        assert!(handles.channel_mut(handle).is_none());
        handles.release_channel(handle);
        assert!(handles.body_mut(handle).is_some());
        for forged in [0, u64::MAX, handle + 1, handle ^ (1 << SLOT_BITS)] {
            assert!(handles.body_mut(forged).is_none());
        }
        assert!(handle < 1 << 53);
    }

    #[test]
    fn the_end_of_an_invocation_releases_every_entry() {
        let mut handles = Handles::default();
        let kept = [
            handles.insert(body()).unwrap(),
            handles.insert(body()).unwrap(),
        ];
        handles.release_all();
        for handle in kept {
            assert!(handles.body_mut(handle).is_none());
        }
        // The slots serve the next invocation under new generations.
        let next = handles.insert(body()).unwrap();
        assert!(!kept.contains(&next));
        assert_eq!(handles.slots.len(), 2);
    }

    #[test]
    fn a_slot_whose_generation_runs_out_is_retired() {
        let mut handles = Handles::default();
        let handle = handles.insert(body()).unwrap();
        handles.slots[0].generation = MAX_GENERATION;
        let last = MAX_GENERATION << SLOT_BITS;
        assert!(handles.body_mut(last).is_some());
        assert!(handles.body_mut(handle).is_none());
        handles.release_body(last);
        let next = handles.insert(body()).unwrap();
        assert_eq!(next & (MAX_SLOTS as u64 - 1), 1);
        assert!(last < 1 << 53);
    }
}
