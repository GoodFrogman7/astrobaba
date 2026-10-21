"""Automatic checks on user-written text (reviews, replies). A hit holds the text for a person
to look at; it is never silently rewritten."""

import re

# Contact details move clients off-platform, the most common consultation scam.
_CONTACT = (
    ("phone number", re.compile(r"(?:\+?\d[\s\-().]*){10,}")),
    ("email address", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("web link", re.compile(r"(?:https?://|www\.)\S+|\b\S+\.(?:com|in|net|org|me|io)\b", re.I)),
    ("messaging handle", re.compile(r"\b(?:whatsapp|telegram|insta(?:gram)?|wa\.me)\b", re.I)),
)
_ABUSE = re.compile(
    r"\b(?:fuck\w*|shit\w*|bitch\w*|bastard\w*|asshole\w*|chutiy\w*|madarchod\w*|bhenchod\w*|"
    r"behenchod\w*|harami\w*|randi\w*)\b|मादरचोद|बहनचोद|चूतिय|हरामी|रंडी",
    re.I,
)
# Health and legal outcome claims cannot be verified and must not be amplified.
_CLAIMS = re.compile(
    r"\b(?:cured?|cures|guarantee\w*|100\s?%\s*(?:sure|accurate|result)|won\s+(?:my|the)\s+"
    r"(?:court|case)|cancer|diabetes|hiv|infertility)\b|इलाज|गारंटी|ठीक\s+हो\s+गय",
    re.I,
)


def moderation_reasons(text: str) -> list[str]:
    reasons = [label for label, pattern in _CONTACT if pattern.search(text)]
    if _ABUSE.search(text):
        reasons.append("abusive language")
    if _CLAIMS.search(text):
        reasons.append("health or legal outcome claim")
    return reasons
