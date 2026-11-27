---
status: accepted
---

# Phone audio enters LiveKit through a bridge on the computer

LiveKit carries all voice on the computer, and its transcription, recording and Live workers read one publisher's microphone track. LiveKit media cannot cross the Relay or enter the encrypted session, because the computer sits behind a home router. We decided that the Mobile App sends audio frames over the encrypted session and a bridge on the computer joins the local LiveKit room in the phone's place and publishes them; reply audio returns the same way. LiveKit, the transcription and recording workers stay unchanged, and provider keys stay on the computer. The Live worker changes in one way: a VoiceSession the Mobile App creates offers no page tools, because a phone has no page to read or operate.

## Considered Options

- **The Mobile App connects to LiveKit directly.** Rejected: it needs a media relay beside the Relay and a publicly reachable LiveKit on the computer, and we found no evidence that this path works reliably.
- **The Mobile App connects to the speech providers directly with short-lived keys.** Rejected: transcripts would have to be sent back by the phone, and the Live prompts and task logic would exist twice.

## Consequences

Audio travels over a reliable connection with sequence numbers, so a dropped connection adds delay instead of losing audio for dictation and recording; Live discards stale audio instead. The Bridge holds a dropped VoiceSession for 10 minutes; a longer outage ends the Capture and the phone attaches its complete local recording to the chat. Echo cancellation happens on the phone.
