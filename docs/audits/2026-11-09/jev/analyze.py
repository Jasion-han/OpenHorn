"""Offline analysis only. Does not send requests or read credentials."""
import collections
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
cases = json.loads((ROOT / "cases.json").read_text())
records = json.loads((ROOT / "live-results.json").read_text())
baseline = json.loads((ROOT / "baseline-results.json").read_text())
by_name = {item["name"]: item for item in records}

def tri(value):
    return True if value >= .7 else False if value <= .3 else None

def stats(values):
    values = sorted(values)
    return {"n": len(values), "min": values[0], "median": (values[(len(values)-1)//2] + values[len(values)//2])/2, "p95_nearest_rank": values[math.ceil(.95*len(values))-1], "max": values[-1]}

validation = []
for record in records:
    if record["status"] != 200:
        continue
    answers = record["response"]["answers"]
    if set(answers) != set(record["payload"]["questions"]):
        validation.append({"request": record["name"], "issue": "question IDs mismatch"})
    for key, question in record["payload"]["questions"].items():
        answer = answers[key]
        if answer["type"] != question["type"]:
            validation.append({"request": record["name"], "question": key, "issue": "type mismatch"})
        if question["type"] == "noul":
            valid = isinstance(answer.get("noul"), (float, int)) and 0 <= answer["noul"] <= 1
        else:
            distribution = answer.get("probabilities", {})
            valid = bool(distribution) and all(0 <= value <= 1 for value in distribution.values()) and abs(sum(distribution.values())-1) <= .03
            if question["type"] == "choice":
                valid = valid and set(distribution) == set(question["criteria"]) and answer.get("choice") in distribution
            else:
                valid = valid and 0 <= answer.get("score", -1) <= len(question["criteria"])-1
        if not valid:
            validation.append({"request": record["name"], "question": key, "issue": "invalid numeric answer"})

route_answers = {}
for record in records:
    if record["name"].startswith(("routing-exploratory-", "routing-holdout-")):
        route_answers.update(record["response"]["answers"])
routing = []
for row in baseline["routing"]:
    answer = route_answers[row["id"] + "_route"]
    routing.append({**row, "jev": answer["choice"], "jevCorrect": answer["choice"] == row["expected"], "jevTopProbability": answer["probabilities"][answer["choice"]], "freshNoul": route_answers[row["id"] + "_fresh"]["noul"]})
route_counts = {split: {"n": len([row for row in routing if split == "all" or row["split"] == split]), "rulesCorrect": sum(row["serverCorrect"] for row in routing if split == "all" or row["split"] == split), "jevCorrect": sum(row["jevCorrect"] for row in routing if split == "all" or row["split"] == split)} for split in ["all", "exploratory", "holdout"]}
reviews = []
review = by_name["review-sentiment-topics"]["response"]["answers"]
for row in cases["reviews"]:
    interpretable = tri(review[row["id"] + "_interpretable"]["noul"])
    predicted = review[row["id"] + "_sentiment"]["choice"] if interpretable is True else "unknown"
    reviews.append({**row, "prediction": predicted, "correct": predicted == row["expected"], "interpretable": interpretable, "topicProbabilities": {topic: review[row["id"] + "_" + topic]["noul"] for topic in ["reliability", "billing", "service", "usability", "performance", "feature"]}})
retrieval = []
retrieval_record = by_name.get("retrieval-relevance-corrected-schema") or by_name["retrieval-relevance"]
answers = retrieval_record["response"]["answers"]
for row in cases["retrieval"]:
    probability = answers[row["id"] + "_relevant"]["noul"]
    retrieval.append({**row, "probability": probability, "decision": tri(probability), "correct": tri(probability) == row["expectedRelevant"], "score": answers[row["id"] + "_score"]["score"]})
grounding = [{**row, "probability": by_name["grounding"]["response"]["answers"][row["id"]]["noul"]} for row in cases["grounding"]]
for row in grounding:
    row["decision"] = tri(row["probability"])
    row["correctWhenDecided"] = row["decision"] == row["expected"] if row["decision"] is not None else None
skills = []
answers = by_name["skill-selection"]["response"]["answers"]
reversed_answers = by_name["skill-option-order"]["response"]["answers"]
for row in cases["skills"]:
    applicable = tri(answers[row["id"] + "_applicable"]["noul"])
    prediction = answers[row["id"] + "_skill"]["choice"] if applicable is True else None
    reversed_prediction = reversed_answers[row["id"] + "_skill"]["choice"] if tri(reversed_answers[row["id"] + "_applicable"]["noul"]) is True else None
    skills.append({**row, "prediction": prediction, "rawChoice": answers[row["id"] + "_skill"]["choice"], "applicableProbability": answers[row["id"] + "_applicable"]["noul"], "correct": prediction == row["expected"], "gatedChoiceStableAfterReorder": prediction == reversed_prediction})
duplicates = [{**row, "probability": by_name["semantic-duplicates"]["response"]["answers"][row["id"]]["noul"]} for row in baseline["duplicates"]]
for row in duplicates:
    row["jevCorrect"] = tri(row["probability"]) == row["expected"]
successful = [record for record in records if record["status"] == 200]
route_order = by_name["routing-option-order"]["response"]["answers"]
summary = {
    "requests": {"attempted": len(records), "successful": len(successful), "rejected": [{"name": record["name"], "status": record["status"], "error": record.get("error")} for record in records if record["status"] != 200]},
    "resolvedModels": sorted(set(record["response"]["model"] for record in successful)),
    "successfulTypedJudgments": sum(len(record["response"]["answers"]) for record in successful),
    "uniqueSyntheticCases": sum(len(items) for items in cases.values()),
    "usage": {"inputTokens": sum(record["response"]["usage"]["input_tokens"] for record in successful), "outputTokens": sum(record["response"]["usage"]["output_tokens"] for record in successful), "costUsdReturnedBySuccessfulRequests": sum(record.get("cost",0) for record in successful)},
    "latencyMs": {"successfulAll": stats([record["latencyMs"] for record in successful]), "warmSerialIndividualRoute": stats([record["latencyMs"] for record in successful if record["name"].startswith("routing-serial-")]), "parallelIndividualRoute": stats([record["latencyMs"] for record in successful if record["name"].startswith("routing-single-")])},
    "routing": route_counts,
    "routingOptionOrderHoldout": {"n": 8, "stable": sum(row["jev"] == route_order[row["id"]+"_route"]["choice"] for row in routing if row["split"] == "holdout")},
    "reviews": {"sentimentCorrectWithInterpretableGate": sum(row["correct"] for row in reviews), "n": len(reviews), "topicGoldEvaluation": "Not performed; six topic probabilities per row inspected qualitatively, no independent topic gold set."},
    "retrieval": {"n": len(retrieval), "correct": sum(row["correct"] for row in retrieval)},
    "grounding": {"n": len(grounding), "decided": sum(row["decision"] is not None for row in grounding), "correctWhenDecided": sum(row["correctWhenDecided"] is True for row in grounding), "uncertain": [row["id"] for row in grounding if row["decision"] is None]},
    "skills": {"n": len(skills), "correctWithApplicabilityGate": sum(row["correct"] for row in skills), "stableAfterReorder": sum(row["gatedChoiceStableAfterReorder"] for row in skills)},
    "duplicates": {"n": len(duplicates), "rulesCorrect": sum(row["actual"] == row["expected"] for row in duplicates), "jevCorrect": sum(row["jevCorrect"] for row in duplicates)},
    "schemaValidationErrors": validation,
    "limits": ["Hand-authored challenge cases, not a representative production accuracy or calibration benchmark.", "Only routing has a predeclared 8-case holdout; no wording tuning followed the observed holdout.", "The rules baseline is routeLiveQuery, not the complete pipeline with its fallback generative classifier.", "The initial Score request used an object for criteria, returned HTTP 400, and was corrected to the documented array form. It is retained as an error, not counted as a judgment." if any(record["status"] == 400 for record in records) else "No rejected schema request in this evidence set.", "Timing is local end-to-end HTTP time; the 3 serial samples are insufficient for a production p95 or SLA.", "No live comparison against the user's ordinary chat model; no claimed total application speedup or realized cost savings.", "The HTTP 400 response has no usage receipt; cost total sums successful receipts only."]
}
(ROOT / "summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
(ROOT / "comparisons.json").write_text(json.dumps({"routing": routing,"reviews":reviews,"retrieval":retrieval,"grounding":grounding,"skills":skills,"duplicates":duplicates},ensure_ascii=False,indent=2)+"\n")
print(json.dumps(summary,ensure_ascii=False,indent=2))
if validation:
    raise SystemExit(1)
