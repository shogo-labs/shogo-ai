# API test fixtures

## `meeting-sample.wav`

Known-phrase audio clip used by the notetaker Playwright e2e test
(`apps/desktop/e2e/notetaker.spec.ts`), injected into the renderer as the
Chromium fake audio capture source.

- **Phrase:** "The quick brown fox jumps over the lazy dog. This is a test recording for the Shogo notetaker."
- **Format:** 16 kHz, mono, 16-bit PCM WAV
- **Voice:** macOS `say -v Samantha -r 160`

### Regenerate

```bash
say -v Samantha -r 160 -o /tmp/sample.aiff \
  "The quick brown fox jumps over the lazy dog. This is a test recording for the Shogo notetaker." \
  && afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/sample.aiff apps/api/test-fixtures/meeting-sample.wav
```

The e2e test asserts the transcript contains at least one of the anchor
words `quick`, `fox`, or `lazy` (case-insensitive) to stay tolerant of ASR
misspellings across Whisper model sizes. Keep those three words in any
regenerated clip.
