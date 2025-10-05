import spacy
from typing import Union
from spacy.matcher import Matcher
from pydantic import BaseModel

from fastapi import FastAPI

app = FastAPI()

nlp = spacy.load("en_core_web_sm")

# Spacy matcher
matcher = Matcher(nlp.vocab)
matcher.add("UNREAD", [[{"LOWER": "unread"}]])
matcher.add("READ", [[{"LOWER": "read"}]])
matcher.add("FROM_ADDRESS", [[{"LOWER": "from", "IS_ALPHA": True, "OP": "+"}]])

# Class Model


class Query(BaseModel):
    query: str


@app.get("/")
async def read_root():
    return {"Hello": "World"}


@app.get("/items/{item_id}")
async def read_item(item_id: int, q: Union[str, None] = None):
    return {"item_id": item_id, "q": q}


@app.post("/parse")
async def parse_query(req: Query):
    print(f"Search query {req}")
    query_doc = nlp(req.query)
    matches = matcher(query_doc)

    filters = {}

    for match_id, start, end in matches:
        label = nlp.vocab.strings[match_id]
        span = query_doc[start:end]

        if (label in ["UNREAD", "READ"]):
            filters["status"] = label.lower()
        elif (label == "FROM_ADDRESS"):
            next_token = span[-1].lower_
            print(f"Next token {next_token}")
            if next_token not in ["yesterday", "today", "week", "month", "year"]:
                print(f"Next token {next_token}")
                sender_name = " ".join(
                    [t.text for t in span if t.lower_ != "from"])

                if (len(sender_name) > 0):
                    filters["from"] = sender_name

    for ent in query_doc.ents:
        if ent.label_ == "DATE":
            filters["date"] = ent.text.lower()

    obj = {
        "intent": "search_emails",
        "filters": filters
    }

    print(f"Intent and filters {obj}")

    return obj
