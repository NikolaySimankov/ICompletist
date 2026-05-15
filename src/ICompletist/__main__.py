"""
Entry point for `python -m ICompletist`.
"""

import json
from pathlib import Path

from .pipeline import batch_extract_pubmed


def main():
    """
    Complete workflow: Auto-discover → Search → Extract → Export
    """

    path = Path(".")

    output_dir = path / "fulldb"
    output_dir.mkdir(exist_ok=True)
    email = "nikolay.simankov@doct.uliege.be"

    # Your target plants (ONLY Latin names needed!)
    plants = ["Capsicum annuum"]

    for plant in plants:

        output_subdir = output_dir / f"{plant.replace(' ', '_').lower()}"
        output_subdir.mkdir(exist_ok=True)

        result = batch_extract_pubmed(
            plant,
            limit=20000,
            email=email,  # Full coverage
            path=output_subdir,
        )

        # Step 3: Export to JSON
        filename = plant.replace(" ", "_").lower() + "articles.json"
        with open(f"{output_subdir}/articles.json", "w") as f:
            json.dump(result, f, indent=2)

    print("\n" + "=" * 70)
    print("✅ COMPLETE! All databases ready.")
    print("=" * 70)
    print(f"\n📁 Files created:")


if __name__ == "__main__":
    main()
