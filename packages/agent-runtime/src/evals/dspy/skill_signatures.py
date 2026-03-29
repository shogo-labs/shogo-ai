"""Skill track DSPy signatures."""

import dspy


class SkillMatcher(dspy.Signature):
    """Semantically match a user message to the best available skill.

    Skills have pipe-separated trigger phrases (e.g. "git summary|repo summary")
    and regex triggers (e.g. "/deploy\\s+(to|on)/").

    The current keyword matcher misses semantic variations like
    "what changed in the codebase" for a "git summary" skill.
    This signature teaches the model to bridge that semantic gap.

    Return "none" with low confidence if no skill matches.
    """
    user_message: str = dspy.InputField(desc="The user's incoming message")
    available_skills: str = dspy.InputField(
        desc="JSON array: [{name, description, trigger}]"
    )

    matched_skill: str = dspy.OutputField(desc="Skill name or 'none'")
    confidence: float = dspy.OutputField(desc="0.0-1.0 confidence in the match")
    reasoning: str = dspy.OutputField()


class SkillCreation(dspy.Signature):
    """Generate a well-structured skill definition markdown file.

    Skills are markdown files with YAML frontmatter containing:
    - name: kebab-case identifier
    - trigger: pipe-separated phrases OR regex pattern
    - tools: comma-separated tool names the skill needs
    - version: semver string

    The body contains markdown instructions for how the agent should
    execute the skill.

    Good triggers:
    - Cover semantic variations, not just exact phrases
    - Include common abbreviations and synonyms
    - 3-6 trigger phrases is ideal

    Bad triggers:
    - Single word that's too generic (e.g. just "check")
    - Overly specific (e.g. "check my GitHub pull requests on repo X")
    """
    user_description: str = dspy.InputField(desc="What the skill should do")

    skill_name: str = dspy.OutputField(desc="Kebab-case skill name, e.g. 'github-pr-check'")
    trigger_pattern: str = dspy.OutputField(desc="Pipe-separated trigger phrases, e.g. 'github prs|pull requests|pr review|check prs'")
    required_tools: str = dspy.OutputField(desc="Comma-separated tool names, e.g. 'web, write_file'")
    skill_body: str = dspy.OutputField(desc="Markdown instructions for executing the skill")
    reasoning: str = dspy.OutputField()
