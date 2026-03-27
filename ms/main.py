import re
import spacy
from pydantic import BaseModel
from fastapi import FastAPI

app = FastAPI()

nlp = spacy.load("en_core_web_sm")

matcher = spacy.matcher.Matcher(nlp.vocab)
matcher.add("UNREAD", [[{"LOWER": "unread"}]])
matcher.add("READ", [[{"LOWER": "read"}]])
# "from john", "from john smith" — one or more alphabetic tokens after "from"
matcher.add("FROM_NAME", [[{"LOWER": "from"}, {"IS_ALPHA": True, "OP": "+"}]])
# "from john@example.com" — SpaCy treats email addresses as single tokens
matcher.add("FROM_EMAIL", [[{"LOWER": "from"}, {"LIKE_EMAIL": True}]])


class Query(BaseModel):
    query: str


def preprocess(query: str) -> str:
    # Normalize "from:x" -> "from x" so SpaCy sees "from" as its own token.
    # Without this, SpaCy tokenizes "from:john" as ["from", ":", "john"] and
    # the colon breaks the two-token matcher patterns above.
    return re.sub(r"\bfrom:(\S+)", r"from \1", query, flags=re.IGNORECASE)


@app.post("/parse")
async def parse_query(req: Query):
    query = preprocess(req.query)
    doc = nlp(query)
    matches = matcher(doc)

    filters: dict = {}

    for match_id, start, end in matches:
        label = nlp.vocab.strings[match_id]
        span = doc[start:end]

        if label in ("UNREAD", "READ"):
            filters["status"] = label.lower()

        elif label in ("FROM_NAME", "FROM_EMAIL"):
            # Drop the "from" token itself; join the rest as the sender value
            sender = " ".join(t.text for t in span if t.lower_ != "from")
            if sender:
                filters["from"] = sender

    for ent in doc.ents:
        if ent.label_ == "DATE":
            filters["date"] = ent.text.lower()

    return {"intent": "search_emails", "filters": filters}
