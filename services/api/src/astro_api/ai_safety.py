"""AI assistant safety rules (ADR-0010; PLAN.md §6, Phase 7).

1. `classify`: a keyword/regex classifier run on every question BEFORE any LLM sees it (in the
   API, and again in the worker). Self-harm, emergencies, medical, legal and financial-advice
   questions are blocked with a reason code and fixed copy that points to people who can help.
   English, Hindi (Devanagari) and common Hinglish. It deliberately prefers false positives.
2. `output_errors`: rules every AI answer must pass before it is stored: the horoscope banned
   claims (astro_api.horoscope_rules.BANNED) plus AI-specific ones (no human impersonation, no
   guarantees, no fear, no remedies or products, no links or phone numbers), length and
   language. Grounding in the chart facts is checked by astro_api.ai_facts.

Copy here is product copy (en + hi) that needs editorial and native-speaker review before launch.
Phase 7 adds verified crisis helplines; until then no phone number is shown (never invent one).
Nothing in this module logs.
"""

import re
from dataclasses import dataclass
from typing import Literal

from astro_api.horoscope_rules import BANNED

Reason = Literal["self_harm", "medical", "legal", "financial", "other"]
Kind = Literal["self_harm", "emergency", "medical", "legal", "financial"]
Language = Literal["en", "hi"]

# Same text as packages/shared/src/disclaimer.ts AI_LABEL (a test keeps them equal).
AI_LABEL: dict[str, str] = {"en": "AI assistant", "hi": "एआई सहायक"}
HANDOFF: dict[str, str] = {
    "en": "This answer was written by an AI, not a person. For a personal reading, "
    "talk to a human astrologer.",
    "hi": "यह जवाब एआई ने लिखा है, किसी व्यक्ति ने नहीं। व्यक्तिगत सलाह के लिए किसी मानव ज्योतिषी से बात करें।",
}

_NOTICES: dict[str, dict[str, str]] = {
    "self_harm": {
        "en": "It sounds like you may be going through something very painful, and you deserve "
        "support from a person right now. This AI assistant can't help with this and is not a "
        "helpline. Please contact a mental-health professional or local emergency services, "
        "or reach out to someone you trust. You have not been charged.",
        "hi": "लगता है आप किसी बहुत कठिन दौर से गुज़र रहे हैं, और आपको अभी किसी इंसान का साथ "
        "मिलना चाहिए। यह एआई सहायक इसमें मदद नहीं कर सकता और यह कोई हेल्पलाइन नहीं है। कृपया "
        "किसी मानसिक स्वास्थ्य विशेषज्ञ या अपनी स्थानीय आपातकालीन सेवा से संपर्क करें, या किसी "
        "भरोसेमंद व्यक्ति से बात करें। आपसे कोई शुल्क नहीं लिया गया है।",
    },
    "emergency": {
        "en": "If you or someone else is in danger, contact local emergency services now. This "
        "AI assistant is not a helpline and can't help in an emergency. You have not been "
        "charged.",
        "hi": "अगर आप या कोई और ख़तरे में है, तो अभी अपनी स्थानीय आपातकालीन सेवा से संपर्क करें। "
        "यह एआई सहायक हेल्पलाइन नहीं है और आपात स्थिति में मदद नहीं कर सकता। आपसे कोई शुल्क "
        "नहीं लिया गया है।",
    },
    "medical": {
        "en": "The AI assistant doesn't answer health or medical questions. Please speak to a "
        "qualified doctor. You have not been charged.",
        "hi": "एआई सहायक स्वास्थ्य या इलाज से जुड़े सवालों के जवाब नहीं देता। कृपया किसी योग्य "
        "डॉक्टर से बात करें। आपसे कोई शुल्क नहीं लिया गया है।",
    },
    "legal": {
        "en": "The AI assistant doesn't answer legal questions. Please speak to a qualified "
        "lawyer. You have not been charged.",
        "hi": "एआई सहायक क़ानूनी सवालों के जवाब नहीं देता। कृपया किसी योग्य वकील से बात करें। "
        "आपसे कोई शुल्क नहीं लिया गया है।",
    },
    "financial": {
        "en": "The AI assistant doesn't give investment, loan or other financial advice. Please "
        "speak to a registered financial adviser. You have not been charged.",
        "hi": "एआई सहायक निवेश, कर्ज़ या पैसों से जुड़ी सलाह नहीं देता। कृपया किसी पंजीकृत वित्तीय "
        "सलाहकार से बात करें। आपसे कोई शुल्क नहीं लिया गया है।",
    },
    "unanswerable": {
        "en": "The AI assistant couldn't write an answer that meets our safety and accuracy "
        "rules, so your payment has been refunded. You can rephrase the question or talk to a "
        "human astrologer.",
        "hi": "एआई सहायक ऐसा जवाब नहीं लिख सका जो हमारे सुरक्षा और सटीकता के नियमों पर खरा उतरे, "
        "इसलिए आपका भुगतान लौटा दिया गया है। आप सवाल दोबारा लिख सकते हैं या किसी मानव ज्योतिषी "
        "से बात कर सकते हैं।",
    },
    "failed": {
        "en": "The AI assistant couldn't answer right now, so your payment has been refunded. "
        "Please try again later or talk to a human astrologer.",
        "hi": "एआई सहायक अभी जवाब नहीं दे सका, इसलिए आपका भुगतान लौटा दिया गया है। कृपया बाद में "
        "फिर कोशिश करें या किसी मानव ज्योतिषी से बात करें।",
    },
}

# For questions the worker blocks after charging, "You have not been charged" becomes a refund.
_REFUNDED: dict[str, str] = {
    "en": "Your payment has been refunded.",
    "hi": "आपका भुगतान लौटा दिया गया है।",
}
_NOT_CHARGED: dict[str, str] = {
    "en": "You have not been charged.",
    "hi": "आपसे कोई शुल्क नहीं लिया गया है।",
}


def notice(kind: str, language: str, *, refunded: bool = False) -> str:
    text = _NOTICES[kind][language]
    if refunded:
        text = text.replace(_NOT_CHARGED[language], _REFUNDED[language])
    return text


def reason_for(kind: Kind) -> Reason:
    return "other" if kind == "emergency" else kind


# ------------------------------------------------------------------ normalisation


def normalise(text: str) -> str:
    """Lower-case, fold nukta and chandrabindu variants, collapse whitespace."""
    t = text.lower().replace("\u093c", "").replace("\u0901", "\u0902")  # nukta; chandrabindu
    t = t.replace("\u2019", "'").replace("\u2018", "'")
    return re.sub(r"\s+", " ", t).strip()


def _word(w: str) -> str:
    """A whole Devanagari word (\\b is unreliable around matras)."""
    return rf"(?<![\u0900-\u097f]){w}(?![\u0900-\u097f])"


def _compile(patterns: tuple[str, ...]) -> list[re.Pattern[str]]:
    return [re.compile(normalise(p) if not p.isascii() else p, re.IGNORECASE) for p in patterns]


# ------------------------------------------------------------------ pre-LLM classifier
# Patterns run on normalise(text). Devanagari patterns are written without nukta (normalised
# anyway). English patterns use \b; Hindi words inflect, so they are mostly bare stems.

SELF_HARM: tuple[str, ...] = (
    r"\bsuicid",
    r"\bkill(ing)? my ?self\b",
    r"\bend(ing)? (my|it) (own )?life\b",
    r"\bend it all\b",
    r"\btake my (own )?life\b",
    r"\b(want|wanna|wish|going|ready|plan(ning)?) to die\b",
    r"\bwant to be dead\b",
    r"\bwish i (was|were) dead\b",
    r"\bbetter off dead\b",
    r"\b(don'?t|do not|no longer) want to (live|be alive|exist)\b",
    r"\bno (reason|point|will) (to|in) liv",
    r"\bnot worth living\b",
    r"\bself[- ]?harm",
    r"\b(hurt|harm|cut|cutting|hurting|harming|injure) (my ?self|myself)\b",
    r"\boverdos",
    r"\bhang my ?self\b",
    r"\bslit my wrist",
    r"\bjump (off|from) (a |the )?(bridge|building|roof|terrace)",
    r"\bkms\b",
    # Hindi (Devanagari)
    r"आत्महत्या",
    r"आत्म हत्या",
    r"खुदकुशी",
    r"खुद कुशी",
    r"मरना चाह",
    r"मर जाना चाह",
    r"मर जाऊं",
    r"मर जाऊ",
    r"मरना है",
    r"जान दे दू",
    r"जान दे दे",
    r"अपनी जान ले",
    r"जीना नहीं",
    r"जीने का मन नहीं",
    r"जीने की इच्छा नहीं",
    r"खुद को (नुकसान|चोट|मार|खत्म)",
    r"अपने आप को (नुकसान|चोट|मार|खत्म)",
    r"जहर खा",
    r"फांसी लगा",
    r"फंदा",
    # Hinglish
    r"\ba+tm(a|aa)?\s?hatya",
    r"\bkhud\s?kushi",
    r"\bkhudkhushi",
    r"\bmar(na|ne) (chaht|chahat|hai\b)",
    r"\bmar jaa?na (chaht|hai\b)",
    r"\bmar ja(u|un|oon|ungi|unga|unga)\b",
    r"\bjaan de (du|dun|doon|dunga|dungi|deta|deti)\b",
    r"\bjee?(na|ne) (nahi|nahin|nai)\b",
    r"\bjee?ne ka (man|mann) (nahi|nahin|nai)",
    r"\bkhud ko (khatam|khatm|maar|mar|nuksan|nuksaan|hurt)",
    r"\bapne aap ko (khatam|khatm|maar|mar|nuksan|nuksaan)",
    r"\b(zeh|jeh|zah)(e?r|ar) kha",
    r"\b(ph|f)aa?nsi (laga|lag)",
)

EMERGENCY: tuple[str, ...] = (
    r"\bemergency\b",
    r"\b(is|am|are) (being )?(beaten|attacked|abused|assaulted)\b",
    r"\b(beating|hitting|attacking|abusing) me\b",
    r"\bdomestic (violence|abuse)\b",
    r"\b(rape|raped|raping)\b",
    r"\bkidnap",
    r"\b(will|going to|wants to|threaten(ed|s|ing)? to) kill me\b",
    r"\bunconscious\b",
    r"\bcollapsed\b",
    r"\bcan'?t breathe\b",
    r"\bheart attack\b",
    r"\bbleeding (heavily|a lot|badly)\b",
    r"\b(in|im|i'm|i am) (in )?danger\b",
    r"\bsomeone is (dying|following me)\b",
    # Hindi
    r"आपातकाल",
    r"इमरजेंसी",
    r"मारपीट",
    r"घरेलू हिंसा",
    r"बलात्कार",
    r"अपहरण",
    r"जान को खतरा",
    r"जान का खतरा",
    r"मार डाले",
    r"मार डालेगा",
    r"बेहोश",
    # Hinglish
    r"\bmaa?r ?pee?t",
    r"\bbalatkar",
    r"\bapharan",
    r"\bjaan (ko|ka) khatra",
    r"\bmaar (dalega|dalegi|dalenge|daalega|daalegi|denge|dega|degi) (mujhe|muje)",
    r"\bbehosh",
)

MEDICAL: tuple[str, ...] = (
    r"\b(have|has|had|got|with|diagnosed|stage|beat|survive)\b.{0,25}\bcancer\b",
    r"\bcancer\b.{0,25}\b(treatment|patient|stage|tumou?r|chemo|surgery|cure|recover|test|"
    r"report|hospital|spread)\b",
    r"\bchemo",
    r"\btumou?r",
    r"\bdiabet",
    r"\bblood (pressure|sugar|test|report)\b",
    r"\bheart (disease|problem|surgery|condition)\b",
    r"\bdiseas",
    r"\billness",
    r"\bsick(ness)?\b",
    r"\bsymptom",
    r"\bdiagnos",
    r"\bmedicin",
    r"\bmedicat",
    r"\btablets?\b",
    r"\bdos(e|age)s?\b",
    r"\bsurger",
    r"\btreatment",
    r"\bcure[ds]?\b",
    r"\bdoctors?\b",
    r"\bhospital",
    r"\bpregnan",
    r"\bmiscarr",
    r"\b(in)?fertil",
    r"\bivf\b",
    r"\bmenstru",
    r"\bdepress(ion|ed)\b",
    r"\banxiety\b",
    r"\bpanic attack",
    r"\bmental (health|illness|disorder)",
    r"\btherap(y|ist)",
    r"\bpsychiatr",
    r"\bcovid\b",
    r"\bfever\b",
    r"\binfection",
    r"\bhiv\b",
    r"\bthyroid",
    r"\bpcos\b|\bpcod\b",
    r"\b(kidney|liver|lung)s?\b",
    r"\basthma",
    r"\bmigraine",
    r"\bhealth\b",
    r"\bhealthy\b",
    r"\bsurgery\b",
    r"\boperation\b.{0,20}\b(hospital|doctor|surgery|knee|heart|eye)\b",
    # Hindi
    r"बीमार",
    r"रोग",
    r"इलाज",
    r"दवा",
    r"दवाई",
    r"डॉक्टर",
    r"डाक्टर",
    r"अस्पताल",
    r"कैंसर",
    r"शुगर",
    r"मधुमेह",
    r"ब्लड प्रेशर",
    r"ऑपरेशन",
    r"आपरेशन",
    r"सर्जरी",
    r"गर्भ",
    r"प्रेग्नेंट",
    r"स्वास्थ्य",
    r"सेहत",
    r"तबीयत",
    r"तबियत",
    r"डिप्रेशन",
    r"अवसाद",
    r"माहवारी",
    r"बुखार",
    # Hinglish
    r"\b(bimar|beemar|bimaar|beemaar)",
    r"\b(bimari|beemari|bimaari|beemaari)",
    r"\b(ilaa?j)\b",
    r"\b(dawa|dawai|davai|dava)\b",
    r"\baspataa?l",
    r"\bsehat\b",
    r"\b(tabiyat|tabiyet|tabeeyat|tabiat|tabeeyet)",
    r"\bswasthya",
    r"\bgarbh",
    r"\bbukhar",
    r"\bshugar\b",
)

LEGAL: tuple[str, ...] = (
    r"\bcourts?\b",
    r"\blawsuit",
    r"\blitigat",
    r"\blawyers?\b",
    r"\battorney",
    r"\blegal\b",
    r"\billegal",
    r"\bpolice\b",
    r"\barrest",
    r"\bjail\b",
    r"\bprison\b",
    r"\bbail\b",
    r"\bfir\b",
    r"\bcustody\b",
    r"\balimony",
    r"\bsu(e|ed|ing)\b",
    r"\bverdict",
    r"\b(court|legal|police|criminal|divorce|property|land) (case|dispute|matter|notice)",
    r"\bcase (against|filed)",
    r"\bchargesheet|\bcharge sheet",
    # Hindi
    r"अदालत",
    r"कोर्ट",
    r"मुकदम",
    r"केस",
    r"वकील",
    r"पुलिस",
    r"जेल",
    r"गिरफ्तार",
    r"जमानत",
    r"कानून",
    r"कचहरी",
    r"एफआईआर",
    # Hinglish
    r"\badaa?lat",
    r"\bmukad(d)?a?ma",
    r"\b(vakil|wakil|vakeel|wakeel)",
    r"\b(kanoon|kanun|qanoon|kanooni|kanuni)",
    r"\b(jamanat|zamanat)",
    r"\b(giraftar|girftar|griftar)",
    r"\bkachahri|\bkacheri",
)

FINANCIAL: tuple[str, ...] = (
    r"\binvest",
    r"\bstocks?\b",
    r"\bshares?\b",
    r"\bshare ?market",
    r"\bstock ?market",
    r"\btrading\b",
    r"\bcrypto",
    r"\bbitcoin",
    r"\bmutual funds?",
    r"\bforex\b",
    r"\blotter(y|ies)\b",
    r"\bgambl",
    r"\bbetting\b",
    r"\bcasino",
    r"\bsatta\b",
    r"\bloans?\b",
    r"\bemis?\b",
    r"\bdebts?\b",
    r"\bmortgage",
    r"\binsurance",
    r"\b(income )?tax(es)?\b",
    r"\b(should|shall|can) i (buy|sell|invest)",
    r"\bbuy or sell\b",
    r"\bportfolio",
    r"\bipo\b",
    r"\bf ?& ?o\b|\bfutures and options",
    # Hindi
    r"निवेश",
    r"शेयर",
    r"स्टॉक",
    r"म्यूचुअल फंड",
    r"क्रिप्टो",
    r"लॉटरी",
    r"लाटरी",
    r"सट्टा",
    r"सट्टे",
    r"जुआ",
    r"लोन",
    r"कर्ज",
    r"कर्जा",
    r"ऋण",
    r"ईएमआई",
    r"बीमा",
    r"टैक्स",
    # Hinglish
    r"\bnivesh",
    r"\bshare ?(bazaar|bazar)",
    r"\b(paisa|paise|paisaa) (lagau|lagaun|lagaoon|lagana|lagau?n?)",
    r"\b(jua|juaa|juwa)\b",
    r"\b(karz|karza|karja|qarz|qarza)\b",
    r"\bbeema|\bbima\b",
)

_GROUPS: tuple[tuple[Kind, list[re.Pattern[str]]], ...] = (
    ("self_harm", _compile(SELF_HARM)),
    ("emergency", _compile(EMERGENCY)),
    ("medical", _compile(MEDICAL)),
    ("legal", _compile(LEGAL)),
    ("financial", _compile(FINANCIAL)),
)


@dataclass(frozen=True)
class Verdict:
    reason: Reason | None  # None: the question may go to the LLM
    kind: Kind | None


def classify(text: str) -> Verdict:
    """First matching category in priority order (self-harm first)."""
    t = normalise(text)
    for kind, patterns in _GROUPS:
        if any(p.search(t) for p in patterns):
            return Verdict(reason_for(kind), kind)
    return Verdict(None, None)


# ------------------------------------------------------------------ language

_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_LATIN = re.compile(r"[a-z]", re.IGNORECASE)
# Hinglish markers that are rarely English words.
_HINGLISH_WORDS = (
    "kya hai hain hoga hogi honge mera meri mere mujhe mujhko mujhse kab kaise kaisa kaisi "
    "kyun kyon kyu nahi nahin milegi milega rahega rahegi shaadi shadi naukri batao bataiye "
    "bataye kitna kitni kitne karu karoon karun chahiye sakta sakti abhi apna apni aapka aapki "
    "humara hamara ghar pyar pyaar jaldi achha accha acha kaun mein"
)
_HINGLISH = frozenset(_HINGLISH_WORDS.split())


def detect_language(text: str) -> Language:
    """`hi` for Devanagari-majority text or Hinglish (two or more Hinglish markers), else `en`.
    Answers to Hinglish questions are written in Hindi (Devanagari)."""
    dev = len(_DEVANAGARI.findall(text))
    lat = len(_LATIN.findall(text))
    if dev and dev >= lat * 0.5:
        return "hi"
    words = set(re.findall(r"[a-z]+", text.lower()))
    return "hi" if len(words & _HINGLISH) >= 2 else "en"


# ------------------------------------------------------------------ post-LLM output rules

ANSWER_WORDS = (20, 250)
ANSWER_MAX_CHARS = 1800

AI_BANNED: tuple[str, ...] = (
    # presenting as a human or as an astrologer
    r"\bas (your|an?) (astrologer|jyotishi|pandit|guru|expert)\b",
    r"\bi(?: am|'m) (an? |your )?(human|person|astrologer|jyotishi|pandit|guru|real)\b",
    r"\bmy (years of )?(experience|practice)\b",
    r"\bin my experience\b",
    r"\bi personally\b",
    r"\bspeaking as\b",
    r"\bmy clients?\b",
    # guarantees and certainty
    r"\bdefinitely\b",
    r"\bsurely\b",
    r"\bfor sure\b",
    r"\bwithout (a |any )?doubt\b",
    r"\bcertain(ly)?\b",
    r"\bpromise",
    r"\bassur",
    r"\binevitabl",
    r"\bno doubt\b",
    r"\bwill (absolutely|undoubtedly)\b",
    # fear
    r"\bdanger",
    r"\bterribl",
    r"\bbad luck\b",
    r"\bunlucky\b",
    r"\bmisfortune",
    r"\bdoomed\b",
    r"\bsuffer",
    r"\bevil\b",
    r"\bruin",
    r"\bcalamit",
    r"\bbeware\b",
    # remedies, rituals and products
    r"\bwear(ing)?\b",
    r"\b(ruby|emerald|sapphire|pearl|coral|diamond|hessonite|cat'?s eye|topaz|opal)\b",
    r"\b(neelam|pukhraj|panna|manik|moti|moonga|gomed|lehsunia)\b",
    r"\b(ring|bracelet|amulet|talisman|locket)s?\b",
    r"\byantra",
    r"\bmantra",
    r"\bchant",
    r"\bdonat",
    r"\bfast(ing)? on\b",
    r"\britual",
    r"\bhomam?\b|\bhavan\b",
    r"\b(buy|purchase)\b",
    r"\bdiscount",
    # advice areas (beyond the horoscope list)
    r"\bloans?\b",
    r"\bstock market\b",
    r"\bcrypto",
    r"\blawyer|\blegal advice|\bcourt\b",
    r"\bdoctor|\bmedical advice|\bsymptom",
    r"\bsuicid|\bself[- ]?harm",
    # links and contact details (never invented)
    r"https?://|www\.",
    r"\b\d{10}\b|\+\d{2}[\s-]?\d{5}",
    r"@\w+\.\w+",
    # Hindi
    r"मैं (एक |आपका |आपकी )?(ज्योतिषी|पंडित|गुरु|इंसान|व्यक्ति)",
    r"आपका ज्योतिषी",
    r"मेरे अनुभव",
    r"पक्का",
    r"जरूर (होग|मिलेग|बनेग)",
    r"अवश्य",
    r"निश्चित",
    r"खतर",
    r"अशुभ",
    r"दुर्भाग्य",
    r"संकट",
    r"विनाश",
    r"मंत्र",
    _word("जाप"),
    r"यंत्र",
    _word("दान"),
    _word("व्रत"),
    r"पहनें|पहनना|पहने",
    r"अंगूठी",
    r"पुखराज|नीलम|माणिक|मूंगा|गोमेद|लहसुनिया",
    _word("मोती"),
    _word("हीरा"),
    r"हवन|अनुष्ठान",
    r"खरीद",
    r"कर्ज|लोन|शेयर",
    r"डॉक्टर|वकील|अदालत",
    r"आत्महत्या",
    # Hinglish
    r"\bpakka\b",
    r"\bzaroor\b|\bjaroor\b",
)

_BANNED = _compile(BANNED) + _compile(AI_BANNED)


def output_errors(text: str, language: str) -> list[str]:
    """Problems with an AI answer (grounding is checked separately). Empty: may be stored."""
    errors: list[str] = []
    if not isinstance(text, str) or not text.strip():
        return ["answer is empty"]
    words = len(text.split())
    if not ANSWER_WORDS[0] <= words <= ANSWER_WORDS[1]:
        errors.append(f"{words} words (expected {ANSWER_WORDS[0]}-{ANSWER_WORDS[1]})")
    if len(text) > ANSWER_MAX_CHARS:
        errors.append(f"{len(text)} characters (at most {ANSWER_MAX_CHARS})")
    dev = len(_DEVANAGARI.findall(text))
    lat = len(_LATIN.findall(text))
    if language == "hi" and dev < 2 * lat:
        errors.append("answer must be in Hindi (Devanagari script)")
    if language == "en" and dev > 0:
        errors.append("answer must be in English")
    t = normalise(text)
    for rx in _BANNED:
        if rx.search(t):
            errors.append(f"banned phrase /{rx.pattern}/")
    return errors
