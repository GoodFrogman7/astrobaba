"""One safety classifier for chat and the AI assistant (docs/api/trust.md §3, ADR-0012).

Two layers, both regex sets over `normalise(text)` in English, Hindi (Devanagari, nukta and
chandrabindu folded) and common Hinglish:

1. Categories (`categories`, `classify`): self_harm, emergency, medical, legal, financial and
   scam, in that priority order. Self-harm and emergency deliberately prefer false positives:
   a wrong crisis banner costs little, a missed one could cost a life. The AI assistant uses the
   first five through astro_api.ai_safety; chat uses self_harm and emergency from the client.
2. Astrologer conduct rules (`astrologer_refusal`): contact details, off-platform payment,
   cure claims (including telling a client to stop medicine or avoid doctors), guarantees,
   fear-based selling and remedy/gemstone sales. A hit refuses the astrologer's message (it is never
   stored). These rules aim to be narrow: an astrologer who says "please see a doctor", "I can't
   guarantee anything" or shares a crisis helpline must not be refused, so most rules are
   ignored when a negation sits right next to the match ("don't", "can't", "नहीं", "mat").

`check_message(role, text)` is what the chat socket calls for every message. Rule ids and the
plain-language rules shown to astrologers live in data/safety/conduct.json (a test keeps the ids
equal). Nothing in this module logs, and no verdict carries the text.

Known limits (ADR-0012): paraphrases, misspellings, digits written as words and images are not
caught; Hindi coverage is stems, not grammar. The rules need native-speaker review.
"""

import json
import re
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal

from astro_api.shared_files import safety_dir

Category = Literal["self_harm", "emergency", "medical", "legal", "financial", "scam"]
CATEGORIES: tuple[Category, ...] = (
    "self_harm",
    "emergency",
    "medical",
    "legal",
    "financial",
    "scam",
)
# Client messages with these are delivered and flag the session (crisis resources, no upsell).
CrisisKind = Literal["self_harm", "emergency"]
CRISIS_KINDS: tuple[CrisisKind, ...] = ("self_harm", "emergency")

# Same values and order as packages/shared/src/chat.ts BLOCK_REASONS (test-enforced).
Refusal = Literal[
    "contact_details",
    "off_platform_payment",
    "cure_claim",
    "guarantee",
    "fear_selling",
    "remedy_sale",
]
REFUSALS: tuple[Refusal, ...] = (
    "contact_details",
    "off_platform_payment",
    "cure_claim",
    "guarantee",
    "fear_selling",
    "remedy_sale",
)


# ------------------------------------------------------------------ normalisation


def normalise(text: str) -> str:
    """Lower-case, fold nukta and chandrabindu variants, collapse whitespace."""
    t = text.lower().replace("\u093c", "").replace("\u0901", "\u0902")  # nukta; chandrabindu
    t = t.replace("\u2019", "'").replace("\u2018", "'")
    return re.sub(r"\s+", " ", t).strip()


def word(w: str) -> str:
    """A whole Devanagari word (\\b is unreliable around matras)."""
    return rf"(?<![ऀ-ॿ]){w}(?![ऀ-ॿ])"


def compile_patterns(patterns: tuple[str, ...]) -> list[re.Pattern[str]]:
    """Devanagari patterns are normalised like the text; ASCII ones are used as written."""
    return [re.compile(normalise(p) if not p.isascii() else p, re.IGNORECASE) for p in patterns]


# ------------------------------------------------------------------ categories
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
    r"\bno (reason|point) (to|in) go(ing)? on\b",
    r"\bnot worth living\b",
    r"\bcan'?t (go on|take (it|this) any ?more)\b",
    r"\b(don'?t|do not) want to wake up\b",
    r"\b(no ?one|nobody) would (miss|care if)\b",
    r"\bsleeping pills\b",
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
    r"आत्मघात",
    r"खुदकुशी",
    r"खुद कुशी",
    r"मरना चाह",
    r"मर जाना चाह",
    r"मर जाऊं",
    r"मर जाऊ",
    r"मरना है",
    r"मरने का (मन|ख्याल|खयाल|विचार)",
    r"जान दे दू",
    r"जान दे दे",
    r"अपनी जान ले",
    r"जीना नहीं",
    r"जीने का मन नहीं",
    r"जीने की इच्छा नहीं",
    r"(जिंदगी|ज़िंदगी|जिन्दगी) से (थक|तंग|परेशान हो)",
    r"(जिंदगी|ज़िंदगी|जिन्दगी) (खत्म|ख़त्म) कर",
    r"खुद को (नुकसान|चोट|मार|खत्म)",
    r"अपने आप को (नुकसान|चोट|मार|खत्म)",
    r"जहर खा",
    r"नींद की गोलि",
    r"फांसी लगा",
    r"फंदा",
    # Hinglish
    r"\ba+tm(a|aa)?\s?hatya",
    r"\bkhud\s?kushi",
    r"\bkhudkhushi",
    r"\bmar(na|ne) (chaht|chahat|hai\b)",
    r"\bmarne ka (man|mann|khayal|khyal|vichar)",
    r"\bmar jaa?na (chaht|hai\b)",
    r"\bmar ja(u|un|oon|ungi|unga|unga)\b",
    r"\bjaan de (du|dun|doon|dunga|dungi|deta|deti)\b",
    r"\bjee?(na|ne) (nahi|nahin|nai)\b",
    r"\bjee?ne ka (man|mann) (nahi|nahin|nai)",
    r"\b(zindagi|jindagi|zindgi) (se )?(thak|tang|khatam|khatm)",
    r"\bsab (khatam|khatm) kar (du|dun|doon|dunga|dungi)\b",
    r"\bkhud ko (khatam|khatm|maar|mar|nuksan|nuksaan|hurt)",
    r"\bapne aap ko (khatam|khatm|maar|mar|nuksan|nuksaan)",
    r"\b(zeh|jeh|zah)(e?r|ar) kha",
    r"\bneend ki goli",
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

# The zodiac sign Cancer is not an illness: words that follow it in astrology talk.
_ZODIAC_AFTER = (
    r"(?!\s*(?:sign|sun|moon|ascendant|asc\b|lagna|rashi|rasi|rising|zodiac|natives?|m[ae]n\b|"
    r"wom[ae]n|people|partner|guy|girl|boy|season|house|as\b|in\b|and\b|or\b|compatib))"
)

MEDICAL: tuple[str, ...] = (
    r"\b(have|has|had|got|diagnosed|suffering from|fighting|battling|stage|beat|survived?)\b"
    r".{0,25}\bcancer\b" + _ZODIAC_AFTER,
    r"\b(lung|breast|blood|skin|bone|throat|mouth|stomach|liver|brain|cervical|prostate|"
    r"colon|oral|pancreatic|ovarian|uterine) cancer\b",
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

# Money moving outside the platform: payment apps, bank details, OTPs, advance fees.
SCAM: tuple[str, ...] = (
    r"\b(g ?pay|google ?pay|phone ?pe|paytm|bhim)\b",
    r"\bupi ?(id|number|no)\b",
    r"\b[\w.-]{2,}@(ok\w+|ybl|ibl|axl|paytm|upi|apl|ptyes|ptsbi|pthdfc|ptaxis)\b",
    r"\b(bank|account) (details|number|no\.?|transfer)\b",
    r"\bifsc\b",
    r"\b(western union|money ?gram)\b",
    r"\b(send|transfer|deposit) (the )?(money|amount|payment|fees?|cash)\b",
    r"\bpay (me )?(directly|personally|outside|separately|privately|in cash|on (upi|gpay|paytm))",
    r"\b(advance|processing|registration|booking) (fee|fees|payment|amount)\b",
    r"\bshare (your|the) otp\b|\botp (share|batao|bhejo|bata do|send)",
    r"\b(outside|off) (the |this )?(app|platform|website|site)\b",
    # Hindi
    r"यूपीआई",
    r"पेटीएम",
    r"गूगल पे",
    r"फोन ?पे",
    r"(बैंक|खाता|अकाउंट) (नंबर|डिटेल|विवरण)",
    r"मेरे (खाते|अकाउंट) में",
    r"पैसे (भेज|ट्रांसफर|डाल)",
    r"ओटीपी",
    r"ऐप के बाहर",
    # Hinglish
    r"\b(paise|paisa|amount|payment) (bhej|bhejo|transfer|daal|dal)",
    r"\b(mere|mera) (account|khata|khate)\b",
    r"\bapp ke bahar\b",
)

_CATEGORY_PATTERNS: dict[Category, tuple[str, ...]] = {
    "self_harm": SELF_HARM,
    "emergency": EMERGENCY,
    "medical": MEDICAL,
    "legal": LEGAL,
    "financial": FINANCIAL,
    "scam": SCAM,
}
_GROUPS: tuple[tuple[Category, list[re.Pattern[str]]], ...] = tuple(
    (c, compile_patterns(_CATEGORY_PATTERNS[c])) for c in CATEGORIES
)


def categories(text: str) -> tuple[Category, ...]:
    """Every category the text matches, in priority order (self-harm first)."""
    t = normalise(text)
    return tuple(c for c, patterns in _GROUPS if any(p.search(t) for p in patterns))


def classify(text: str, among: tuple[Category, ...] = CATEGORIES) -> Category | None:
    """The first category in priority order among `among`, or None."""
    t = normalise(text)
    for c, patterns in _GROUPS:
        if c in among and any(p.search(t) for p in patterns):
            return c
    return None


# ------------------------------------------------------------------ astrologer conduct rules

# A negation just before (English) or just after (Hindi, Hinglish) a match cancels it:
# "I can't guarantee", "no guarantee", "गारंटी नहीं", "dawai band mat karo".
_NEG_BEFORE = re.compile(
    r"(\b(not|never|cannot|can'?t|won'?t|don'?t|doesn'?t|shouldn'?t|mustn'?t|avoid|without|"
    r"no ?one can|nobody can)\b(\s+[\w']+){0,3}\s*"
    r"|\bno\s+|\bno(\s+\w+){1,2}\s+(can|will|could)\s+)$"
)
# cure_claim only: "ask your doctor before you stop ..." defers to the doctor.
_DEFER_BEFORE = re.compile(r"\b(before|unless|until)\b(\s+[\w']+){0,3}\s*$")
_NEG_AFTER = re.compile(r"^\s*(\S+\s+){0,2}?(नहीं|नही|मत|\bnahi\b|\bnahin\b|\bnhi\b|\bmat\b)")

_CURRENCY = r"(?:₹|\brs\.?|\binr\b|\brupees?\b|\brupaye\b|रुपये|रुपए|रु\.)"
_ITEMS_EN = (
    r"\b(?:gem ?stones?|stones?|ratnas?|rudraksh\w*|yantras?|kavach\w*|amulets?|talismans?|"
    r"tabeez|taveez|tabiz|lockets?|bracelets?|rings?|neelam|pukhraj|panna|moonga|gomed|manik|"
    r"rub(y|ies)|emeralds?|sapphires?|corals?|pearls?|puja|pooja|havan|hawan|homam?|anushthan|"
    r"jaap|remedy kits?|energi[sz]ed \w+)\b"
)
_MONEY_EN = (
    r"(?:\bbuy\b|\bpurchase\b|\border\b|\bprice\b|\bcosts?\b|\bpay\b|\bpayment\b|\bcharges?\b|"
    r"\bfees?\b|\bcourier\b|\bdeliver\w*|\bsell\w*|\bfor (just|only)\b|\bkharid\w*|\bkee?mat\b|"
    r"\bdaam\b|\bmangwa\w*|\bmangva\w*|\bbhej (dunga|dungi|du|dun|doon)\b|" + _CURRENCY + ")"
)
_DEV_START = r"(?<![\u0900-\u097f])"
_DEV_END = r"(?![\u0900-\u097f])"
_ITEMS_HI = (
    _DEV_START + r"(?:रत्न|नग" + _DEV_END + r"|पत्थर|रुद्राक्ष|यंत्र|कवच|ताबीज|अंगूठी|लॉकेट|नीलम|"
    r"पुखराज|पन्ना|मूंगा|गोमेद|माणिक|मोती|पूजा|हवन|अनुष्ठान|जाप" + _DEV_END + ")"
)
_MONEY_HI = (
    _DEV_START + r"(?:खरीद|कीमत|दाम|रुपये|रुपए|₹|भेज दू|भेजू|मंगवा|ऑर्डर|शुल्क|फीस|पेमेंट|"
    r"भुगतान|करवा दू|करा दू)"
)


@dataclass(frozen=True)
class _Rule:
    reason: Refusal
    patterns: tuple[str, ...]
    negatable: bool = True
    # Proximity rules ("pay ... gemstone"): a negation inside the match cancels it too.
    inside: bool = False


_RULES: tuple[_Rule, ...] = (
    # Literal contact data is refused whatever surrounds it.
    _Rule(
        "contact_details",
        (
            r"(?<!\d)(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)",  # Indian mobile
            r"(?<!\d)\d{10,}(?!\d)",
            r"\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b",  # email
            r"(?:https?://|www\.)\S+",
            r"\b[a-z0-9-]{2,}\.(?:com|net|org|io|info|link|xyz)\b",
            r"\b[a-z0-9-]{2,}\.co\.in\b|\b[a-z0-9-]{3,}\.in/",
            r"\bwa\.me\b|\bt\.me\b",
        ),
        negatable=False,
    ),
    _Rule(
        "contact_details",
        (
            r"\b(whats ?app|watsapp|whatsap|telegram|insta(gram)?|snapchat|signal app|facebook|"
            r"fb messenger)\b",
            r"\b(call|text|message|ping|dm|contact|reach) me (on|at|directly|personally|outside)",
            r"\b(my|personal) (number|mobile|phone|email|whats ?app)\b",
            r"\b(give|send|share) (me )?(your )?(number|mobile|phone no|contact)\b",
            r"व्हाट्सए?प|टेलीग्राम|इंस्टाग्राम",
            r"(मेरा|मेरे) (नंबर|मोबाइल|फोन)",
            r"(अपना|अपने) (नंबर|मोबाइल)",
            r"\b(mera|apna) (number|no\.?|mobile)\b",
        ),
    ),
    _Rule("off_platform_payment", SCAM),
    _Rule(
        "remedy_sale",
        (
            _MONEY_EN + r".{0,40}" + _ITEMS_EN,
            _ITEMS_EN + r".{0,40}" + _MONEY_EN,
            r"\bi (will|can|shall) (send|provide|arrange|do|perform|courier|give) (you )?"
            r"(a |an |the |this |one )?(special )?" + _ITEMS_EN,
            r"\bfrom me\b.{0,30}" + _ITEMS_EN + "|" + _ITEMS_EN + r".{0,30}\bfrom me\b",
            _MONEY_HI + r".{0,40}" + _ITEMS_HI,
            _ITEMS_HI + r".{0,40}" + _MONEY_HI,
            _ITEMS_HI + r".{0,25}(मैं|मै) (भेज|करवा|करा|कर) (दू|दूं|दूंगा|दूंगी|दूँगा|दूँगी)",
            r"\b(puja|pooja|havan|hawan|jaap|anushthan)\b.{0,30}\b(karwa|karva|kara) (dunga|dungi|"
            r"du|dun|doon|denge)\b",
        ),
        inside=True,
    ),
    _Rule(
        "cure_claim",
        (
            r"\bcure[sd]?\b",
            r"\bheal (your|the|this|her|his) (disease|illness|cancer|diabetes|infertility|"
            r"depression|sickness)",
            r"\b(disease|illness|cancer|diabetes|infertility|depression|sickness|bp|sugar)\b.{0,30}"
            r"\b(will|shall) (go away|disappear|vanish|be gone|end|be removed|be finished)\b",
            r"\bget rid of (your |the |this )?(disease|illness|cancer|diabetes|infertility|"
            r"depression|sickness)",
            r"\brog mukt\b|\b(bimari|beemari|rog) (door|khatam|khatm|theek|thik) ho",
            r"(बीमारी|रोग|कैंसर|शुगर|डिप्रेशन|बांझपन)[^ ]*.{0,25}(ठीक|दूर|खत्म|गायब) (हो जा|कर दे|कर दू)",
            r"रोग ?मुक्त",
            r"इलाज (कर दूं|कर दूंगा|कर दूंगी|कर देंगे|हो जाएगा|हो जायेगा)",
        ),
    ),
    _Rule(
        "guarantee",
        (
            r"\bguarantee",
            r"\b100\s?(%|percent|per cent)",
            r"\b(definitely|surely|certainly|for sure|without (a |any )?doubt) (will|going to|get|"
            r"happen|marry|win|succeed|come back|return)\b",
            r"\bwill (definitely|surely|certainly|100%) ",
            r"\bi promise (you|that)\b",
            r"\b(shartiya|sau pratishat|100 taka)\b",
            r"\bpakka (hoga|hogi|milega|milegi|ho jayega|ho jayegi|hai|result)\b",
            r"गारंटी",
            r"पक्का (होगा|होगी|मिलेगा|मिलेगी|हो जाएगा|हो जाएगी|है)",
            r"शर्तिया",
            r"(100|सौ) (प्रतिशत|फीसदी|टका)",
            r"निश्चित रूप से",
        ),
    ),
    _Rule(
        "fear_selling",
        (
            r"\bcurse[sd]?\b",
            r"\bblack magic\b|\bwitchcraft\b|\bvoodoo\b",
            r"\b(kala|kaala) (jadu|jaadu)\b|\bjadu ?tona\b|\btona ?totka\b|\bshra+p\b",
            r"\b(will|going to|may|might|could) (die|be killed|lose (your|his|her|their) life)\b",
            r"\b(early|untimely|sudden|premature) death\b",
            r"\bdeath (yoga|yog|of your|in your family|is (near|coming|written))\b",
            r"\b(very |extremely )?dangerous (period|time|yoga|yog|dosh|dosha)\b",
            r"\b(something )?(terrible|horrible|very bad) (will|is going to) happen\b",
            r"\b(otherwise|or else|if you don'?t)\b.{0,60}\b(die|death|ruin\w*|destroy\w*|"
            r"accident|disaster|suffer|lose everything|bad luck)\b",
            r"\b(destroy|ruin) (your|the) (family|marriage|life|business|career)\b",
            r"\b(your|the) (family|marriage|life|business|career) will be (destroyed|ruined)\b",
            r"\b(warna|varna|nahi to|nahin to)\b.{0,50}\b(maut|mar ja\w*|barbaa?d|nuksaa?n|"
            r"accident|tabaah|tabah)",
            r"\bmaut (ho|ka yog|aa)\w*|\bbarbaa?d ho ja",
            r"श्राप|काला जादू|जादू ?टोना|टोना ?टोटका",
            r"अकाल मृत्यु",
            r"मृत्यु (योग|का योग|होगी|हो सकती|हो जाएगी)",
            r"मौत (होगी|हो सकती|हो जाएगी|का योग)",
            r"मर (जाएगा|जाएगी|जाओगे|जाएंगे|जायेगा|जायेगी)",
            r"बर्बाद हो (जा|जाएगा|जाएगी|जाएंगे)",
            r"(वरना|नहीं तो).{0,50}(मृत्यु|मौत|बर्बाद|नुकसान|दुर्घटना|अनर्थ|तबाह)",
        ),
    ),
    _Rule(
        # Telling a client to drop medicine or doctors: the claim that astrology replaces care.
        "cure_claim",
        (
            # Up to three words may name the illness or kind ("stop your blood pressure medicine").
            r"\bstop (taking )?(your |the )?([a-z]+ ){0,3}(medicines?|medication|treatment|tablets|"
            r"pills|insulin|chemo|therapy)\b",
            r"\b(no need|don'?t need|do not need) (for |of |to (see|visit|go to|consult) )?"
            r"(a |the |any )?([a-z]+ ){0,2}(doctors?|medicines?|medication|treatment|hospital|"
            r"surgery|therapy)\b",
            r"\binstead of (a |the |your )?(doctors?|medicines?|medication|treatment|chemo|"
            r"surgery|hospital|therapy)\b",
            r"\b(don'?t|do not|never) (go to|see|visit|consult|trust) (a |the |any )?(doctors?|"
            r"hospital)\b",
            r"(दवा|दवाई|दवाइयां|इलाज) (बंद|छोड़|छोड|मत ले)",
            r"(डॉक्टर|डाक्टर|अस्पताल) (के पास )?(मत|न) जा",
            r"\b(dawa|dawai|davai|dava|ilaj|ilaaj) (band|chhod|chod|mat le)",
            r"\bdoctor (ke paas |ke pas )?(mat|na) ja",
        ),
    ),
)

_NEG_INSIDE = re.compile(
    r"\b(not|never|cannot|can'?t|won'?t|don'?t|doesn'?t|no need|avoid|nahi|nahin|mat)\b|नहीं|नही|मत"
)
_COMPILED_RULES: tuple[tuple[_Rule, list[re.Pattern[str]]], ...] = tuple(
    (r, compile_patterns(r.patterns)) for r in _RULES
)


def _negated(t: str, m: re.Match[str], rule: _Rule) -> bool:
    before = t[max(0, m.start() - 40) : m.start()]
    after = t[m.end() : m.end() + 25]
    if rule.inside and _NEG_INSIDE.search(m.group(0)):
        return True
    if rule.reason == "cure_claim" and _DEFER_BEFORE.search(before):
        return True
    return bool(_NEG_BEFORE.search(before) or _NEG_AFTER.search(after))


def _hit(t: str, rule: _Rule, patterns: list[re.Pattern[str]]) -> bool:
    for p in patterns:
        for m in p.finditer(t):
            if not rule.negatable or not _negated(t, m, rule):
                return True
    return False


def astrologer_refusal(text: str) -> Refusal | None:
    """The first conduct rule an astrologer's message breaks, or None."""
    t = normalise(text)
    for rule, patterns in _COMPILED_RULES:
        if _hit(t, rule, patterns):
            return rule.reason
    return None


# ------------------------------------------------------------------ chat


@dataclass(frozen=True)
class ChatCheck:
    """What the chat does with one message. `deliver`: store and send as usual. `flag`: store
    and send, flag the session (`crisis`), send both sides a `safety` event and pause upsell.
    `refuse`: not stored, the sender gets `message_blocked` with `refusal`."""

    action: Literal["deliver", "flag", "refuse"]
    crisis: CrisisKind | None = None
    refusal: Refusal | None = None

    @property
    def banner(self) -> Literal["crisis", "none"]:
        """What the client sees: crisis resources and the not-a-helpline notice, or nothing."""
        return "crisis" if self.action == "flag" else "none"


def check_message(role: str, text: str) -> ChatCheck:
    """Client messages are never refused (a person in crisis must always get through); astrologer
    messages are checked against the conduct rules."""
    if role == "user":
        crisis = classify(text, CRISIS_KINDS)
        if crisis == "self_harm" or crisis == "emergency":
            return ChatCheck("flag", crisis=crisis)
        return ChatCheck("deliver")
    refusal = astrologer_refusal(text)
    if refusal is not None:
        return ChatCheck("refuse", refusal=refusal)
    return ChatCheck("deliver")


# ------------------------------------------------------------------ data files


@cache
def helplines() -> dict[str, Any]:
    """data/safety/helplines.json (verified numbers only; never add one by hand here)."""
    data: dict[str, Any] = json.loads((safety_dir() / "helplines.json").read_text("utf-8"))
    return data


@cache
def conduct() -> dict[str, Any]:
    """data/safety/conduct.json: the astrologer conduct rules (ids = refusal reasons + review-only
    rules) and the guidance shown to an astrologer when a session is flagged."""
    data: dict[str, Any] = json.loads((safety_dir() / "conduct.json").read_text("utf-8"))
    return data


def resources() -> dict[str, Any]:
    """`SafetyResources` (packages/shared/src/trust.ts): both languages of every field."""
    h = helplines()
    return {
        "helplines": [
            {
                "id": x["id"],
                "name": x["name"],
                "number": x["number"],
                "hours": x["hours"],
                "official_site": x["official_site"],
            }
            for x in h["helplines"]
        ],
        "not_a_helpline": h["not_a_helpline"],
        "verified_by_founder": bool(h.get("verified_by_founder")),
        "checked_on": h.get("checked_on"),
    }


def refusal_message(reason: str, language: str = "en") -> str:
    """The plain rule text for a refusal (from conduct.json), for the astrologer's error."""
    for rule in conduct()["rules"]:
        if rule["id"] == reason:
            return str(rule["rule"].get(language) or rule["rule"]["en"])
    return "This message breaks the platform's conduct rules and was not sent."
