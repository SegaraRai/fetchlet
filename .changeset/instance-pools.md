---
"@fetchlet-crates/fetchlet": minor
---

`WorkerOptions::instances` runs several instances behind one `AppHandle`, each on its own worker thread and each running one call at a time. Commands wait in one queue and go to whichever instance is free; the pool starts `min` instances, adds one when a command waits and every instance is busy, up to `max`, and retires instances above `min` after `idle_timeout`. The default is one instance, as before. A retired instance is now rebuilt right after the call that retired it instead of when the next call arrives.
