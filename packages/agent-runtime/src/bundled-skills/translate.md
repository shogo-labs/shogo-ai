---
name: translate
version: 1.0.0
description: Translate text between languages
trigger: "translate|translation|in spanish|in french|in german|in japanese|in chinese|to english"
tools: [web_fetch]
---

# Translate

When the user asks for a translation:

1. **Detect** the source language (or use what the user specified)
2. **Identify** the target language from the request
3. **Translate** the text accurately, preserving:
   - Meaning and nuance
   - Tone and formality level
   - Technical terms (with notes if needed)
4. **Provide** the translation with context

## Output Format

### Translation

**From:** [Source Language]
**To:** [Target Language]

**Original:**
> [Original text]

**Translation:**
> [Translated text]

**Notes:**
- [Any nuances, alternative translations, or cultural context worth noting]

For longer texts, maintain paragraph structure. For technical content, note any terms that don't have direct translations.
