"""Ashtakoota (Guna Milan) matching from the two Moons. Tables: data/astro/matching.json."""

from typing import Any

from astro_engine.tables import get_tables


def _vashya_group(sign_index: int, degree_in_sign: float) -> str:
    groups: list[str] = get_tables().sign(sign_index)["vashya"]
    return groups[0] if degree_in_sign < 15.0 else groups[1]


def _relation(of: str, to: str) -> str:
    rel = get_tables().friendships[of]
    if to in rel["friends"]:
        return "friend"
    if to in rel["enemies"]:
        return "enemy"
    return "neutral"


def _graha_maitri(lord_g: str, lord_b: str) -> tuple[float, str]:
    pts = get_tables().matching["graha_maitri"]["points"]
    if lord_g == lord_b:
        return pts["same_lord"], "same_lord"
    pair = sorted([_relation(lord_g, lord_b), _relation(lord_b, lord_g)])
    key = {
        ("friend", "friend"): "friend_friend",
        ("friend", "neutral"): "friend_neutral",
        ("neutral", "neutral"): "neutral_neutral",
        ("enemy", "friend"): "friend_enemy",
        ("enemy", "neutral"): "neutral_enemy",
        ("enemy", "enemy"): "enemy_enemy",
    }[(pair[0], pair[1])]
    return pts[key], key


def _tara(from_nak: int, to_nak: int) -> int:
    count = (to_nak - from_nak) % 27 + 1
    return count % 9 or 9


def ashtakoota(groom_moon: dict[str, Any], bride_moon: dict[str, Any]) -> dict[str, Any]:
    """Each argument is a placement() dict of the person's sidereal Moon."""
    t = get_tables()
    m = t.matching
    g_sign, b_sign = t.sign(groom_moon["sign_index"]), t.sign(bride_moon["sign_index"])
    g_nak, b_nak = (
        t.nakshatras[groom_moon["nakshatra_index"]],
        t.nakshatras[bride_moon["nakshatra_index"]],
    )
    kootas: list[dict[str, Any]] = []

    def add(koota: str, points: float, **detail: Any) -> None:
        kootas.append(
            {"koota": koota, "points": points, "max": m["maxima"][koota], "detail": detail}
        )

    ranks = m["varna_rank"]
    add(
        "varna",
        1 if ranks[g_sign["varna"]] >= ranks[b_sign["varna"]] else 0,
        groom=g_sign["varna"],
        bride=b_sign["varna"],
    )

    vg = _vashya_group(groom_moon["sign_index"], groom_moon["degree_in_sign"])
    vb = _vashya_group(bride_moon["sign_index"], bride_moon["degree_in_sign"])
    groups = m["vashya"]["groups"]
    add("vashya", m["vashya"]["matrix"][groups.index(vg)][groups.index(vb)], groom=vg, bride=vb)

    tara_bg = _tara(bride_moon["nakshatra_index"], groom_moon["nakshatra_index"])
    tara_gb = _tara(groom_moon["nakshatra_index"], bride_moon["nakshatra_index"])
    bad = m["tara"]["bad_taras"]
    per = m["tara"]["points_per_direction"]
    add(
        "tara",
        (0 if tara_bg in bad else per) + (0 if tara_gb in bad else per),
        bride_to_groom=tara_bg,
        groom_to_bride=tara_gb,
    )

    animals = m["yoni"]["animals"]
    ya, yb = g_nak["yoni"]["animal"], b_nak["yoni"]["animal"]
    add("yoni", m["yoni"]["matrix"][animals.index(ya)][animals.index(yb)], groom=ya, bride=yb)

    pts, rel = _graha_maitri(g_sign["lord"], b_sign["lord"])
    add("graha_maitri", pts, groom_lord=g_sign["lord"], bride_lord=b_sign["lord"], relation=rel)

    ganas = m["gana"]["groups"]
    add(
        "gana",
        m["gana"]["matrix"][ganas.index(g_nak["gana"])][ganas.index(b_nak["gana"])],
        groom=g_nak["gana"],
        bride=b_nak["gana"],
    )

    distance = (groom_moon["sign_index"] - bride_moon["sign_index"]) % 12 + 1
    bhakoot_bad = distance in m["bhakoot"]["bad_sign_distances"]
    add("bhakoot", 0 if bhakoot_bad else m["bhakoot"]["points"], sign_distance=distance)

    nadi_same = g_nak["nadi"] == b_nak["nadi"]
    add("nadi", 0 if nadi_same else m["maxima"]["nadi"], groom=g_nak["nadi"], bride=b_nak["nadi"])

    total = sum(k["points"] for k in kootas)
    return {
        "system": "ashtakoota",
        "kootas": kootas,
        "total": total,
        "max": sum(m["maxima"].values()),
        "doshas": {"nadi": nadi_same, "bhakoot": bhakoot_bad},
        "tables_review_status": m["review"]["status"],
    }
