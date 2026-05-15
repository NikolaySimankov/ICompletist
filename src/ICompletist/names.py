"""
Part 1 – Common name discovery via Wikidata.
"""

import requests
from typing import List


def get_common_names_from_wikidata(
    scientific_name: str,
    email: str = "research@example.com",
) -> list:
    """Fetch from Wikidata - no API key needed"""
    try:
        headers = {"User-Agent": email}
        url = "https://www.wikidata.org/w/api.php"
        params = {
            "action": "wbsearchentities",
            "search": scientific_name,
            "language": "en",
            "format": "json",
        }
        response = requests.get(url, params=params, headers=headers, timeout=10)
        data = response.json()

        if not data.get("search"):
            return []

        entity_id = data["search"][0]["id"]
        entity_url = (
            f"https://www.wikidata.org/wiki/Special:EntityData/{entity_id}.json"
        )
        entity_response = requests.get(entity_url, headers=headers, timeout=10)
        entity_data = entity_response.json()

        entity = entity_data["entities"][entity_id]

        label = entity.get("labels", {}).get("en", {}).get("value")
        aliases = [a["value"] for a in entity.get("aliases", {}).get("en", [])]

        common_names = list(
            dict.fromkeys(name for name in [label] + aliases[:5] if name)
        )

        return list(set([scientific_name] + common_names))

    except Exception as e:
        print(f"  Wikidata error: {e}")
        return []


def build_all_names_json(
    plant_species: str,
    email: str = "research@example.com",
) -> List[str]:
    """
    Auto-discover all names for all plants and save to JSON.
    """

    print(f"  {plant_species}...", end=" ")

    # Try Wikidata first (free, fast)
    names = get_common_names_from_wikidata(plant_species, email)

    print(f"✓ Found {len(names)} names: {', '.join(names)}")

    return names
