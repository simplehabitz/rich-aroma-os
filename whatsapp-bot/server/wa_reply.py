"""
Structured WhatsApp replies (bot-menu-fix, 2026-10-26).

Engines answer plain strings for plain text. A MENU answer is not
plain text: the owner's ruling is that the catalog is never dumped
into chat as one long message. A menu answer is a short body + an
interactive payload (a section LIST the customer taps through, or
a CTA-URL button to the photo storefront) + a plain-text fallback
for sends/clients that can't carry the interactive shape.

WaReply bundles those three renderings so the webhook can try the
interactive send first and degrade to text without the engines
knowing anything about the Graph API:

    kind         'list' | 'cta_url'
    body         the short body text of the interactive message
    fallback     the plain-text rendering (NEVER a catalog dump:
                 section names + numbers + the web link)
    button_text  list only: the button that opens the list
    sections     list only: Graph sections payload —
                 [{title, rows: [{id, title, description}]}]
    cta          cta_url only: {display_text, url}

prepend()/append() fold extra lines (a greeting before, a tail
question after) into BOTH renderings, so whichever one the
customer ends up seeing tells the whole story.
"""


class WaReply:
    def __init__(self, kind, body, fallback, button_text=None,
                 sections=None, cta=None):
        self.kind = kind
        self.body = body
        self.fallback = fallback
        self.button_text = button_text
        self.sections = sections or []
        self.cta = cta

    def prepend(self, line: str) -> "WaReply":
        if line:
            self.body = line + "\n" + self.body
            self.fallback = line + "\n" + self.fallback
        return self

    def append(self, line: str) -> "WaReply":
        if line:
            self.body = self.body + "\n" + line
            self.fallback = self.fallback + "\n" + line
        return self

    def fallback_text(self) -> str:
        return self.fallback

    def __repr__(self):  # debugging / logs only
        return f"<WaReply {self.kind} body={self.body[:40]!r}...>"
