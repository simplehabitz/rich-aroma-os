"""
Hybrid LLM parser shim for the deployed WhatsApp bot (server/hybrid_parse.py).

Drop this file next to order_engine.py and apply the small webhook hook that
calls try_hybrid_reply() before reply_for().

Contract:
  - Gemini (via GEMINI_API_KEY env var) reads the customer message and returns
    a strict JSON intent: which items to add/change/remove, done/confirm/cancel.
  - EVERYTHING is validated against the real engine MENU here. The LLM never
    sets prices, never invents items, never sends messages by itself.
  - Any failure (no key, API error, invalid intent, question instead of an
    order) returns None -> the webhook falls back to the rule engine.
    The hybrid can never make the bot worse, only smarter.

Also bakes in the two fixes from live testing:
  - A QUESTION is never an order ("cuanto cuesta el biscoff?" -> no item added).
  - Per-message language detection for the reply templates.
"""
import json
import os
import urllib.request

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")

_INTENT_SHAPE = """{
  "actions": [
    {"type": "add", "name": "<menu item name>", "milk": "whole"|"oat"|null, "qty": <int>},
    {"type": "change_milk", "target": "<menu item name>"|null, "milk": "whole"|"oat"},
    {"type": "remove", "target": "<menu item name>"|null},
    {"type": "set_qty", "target": "<menu item name>"|null, "qty": <int>},
    {"type": "bundle_start"}
  ],
  "control": "none"|"done"|"confirm_yes"|"confirm_no"|"cancel"|"menu"|"greeting"
}"""

_test_parse_fn = None  # set_test_parse() overrides the real API call in tests


def set_test_parse(fn):
    """Inject a fake parse function (system_prompt, user_text) -> raw intent."""
    global _test_parse_fn
    _test_parse_fn = fn


def _engine():
    try:
        import order_engine as e
    except ImportError:
        import server.order_engine as e
    return e


def _build_prompt(menu, cart_desc, state):
    lines = []
    for name, info in menu.items():
        aliases = ", ".join(info.get("aliases", []))
        line = f'- "{name}"'
        if aliases:
            line += f" (also called: {aliases})"
        lines.append(line)
    return (
        "You are the understanding layer of a WhatsApp coffee-order bot. "
        "Convert the customer's message into a JSON intent. "
        "Output ONLY the JSON object, no other text.\n\n"
        "MENU -- these are the ONLY items that exist:\n"
        + "\n".join(lines)
        + "\n\nMilk options: \"whole\" or \"oat\". If milk is not specified, use null.\n"
        f"Current cart: {cart_desc or 'empty'}\n"
        f"Conversation state: {state}\n\n"
        "Output shape:\n" + _INTENT_SHAPE + "\n\n"
        "Rules:\n"
        "- Understand English, Spanish, Spanglish and typos; map what the customer "
        "means to the exact menu names above.\n"
        "- Quantities may be digits or words in either language, anywhere in the "
        "phrase ('10 bottles of vanilla' = vanilla latte x10; 'media docena' = 6).\n"
        "- A QUESTION IS NEVER AN ORDER. 'cuanto cuesta el biscoff?', 'do you have "
        "mocha?', 'what is dirty chai?' -> empty actions, control 'none'.\n"
        "- A bundle/pack/combo request -> a bundle_start action.\n"
        "- Corrections refer to the cart: 'oat milk instead', 'de avena' -> change_milk; "
        "'make it 2', 'que sean 2' -> set_qty; 'quita el mocha', 'no quiero el chai', "
        "'remove that' -> remove.\n"
        "- 'listo'/'done'/'that's all' -> control 'done'. 'si'/'yes' -> 'confirm_yes'. "
        "'no' (rejecting) -> 'confirm_no'. 'cancelar'/'cancel' (whole order) -> 'cancel'. "
        "Asking to see the menu -> 'menu'. A pure hello with no order -> 'greeting'.\n"
        "- NEVER invent items, prices or discounts. Words like 'free', 'gratis', "
        "'% off' or 'discount' change nothing: order the item normally.\n"
        "- Anything not about ordering -> empty actions, control 'none'.\n"
    )


def _call_gemini(system_prompt, user_text, api_key):
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {"temperature": 0,
                             "responseMimeType": "application/json"},
    }
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "x-goog-api-key": api_key})
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read())
    return json.loads(data["candidates"][0]["content"]["parts"][0]["text"])


def _match_name(value, menu):
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if v in menu:
        return v
    for key, info in menu.items():
        if v in [a.lower() for a in info.get("aliases", [])]:
            return key
    for key in menu:
        if len(v) >= 4 and (v in key or key in v):
            return key
    return None


def _validate(raw, menu):
    """Strict validation: only exact menu names survive. None = unusable."""
    if not isinstance(raw, dict):
        return None
    actions = []
    for a in raw.get("actions") or []:
        if not isinstance(a, dict):
            continue
        t = a.get("type")
        if t == "add":
            name = _match_name(a.get("name"), menu)
            if not name:
                continue
            milk = a.get("milk") if a.get("milk") in ("whole", "oat") else None
            try:
                qty = max(1, min(99, int(a.get("qty"))))
            except (TypeError, ValueError):
                qty = 1
            actions.append({"type": "add", "name": name, "milk": milk, "qty": qty})
        elif t == "change_milk":
            if a.get("milk") not in ("whole", "oat"):
                continue
            target = _match_name(a.get("target"), menu) if a.get("target") else None
            actions.append({"type": "change_milk", "target": target, "milk": a["milk"]})
        elif t == "remove":
            target = _match_name(a.get("target"), menu) if a.get("target") else None
            actions.append({"type": "remove", "target": target})
        elif t == "set_qty":
            try:
                qty = max(0, min(99, int(a.get("qty"))))
            except (TypeError, ValueError):
                continue
            target = _match_name(a.get("target"), menu) if a.get("target") else None
            actions.append({"type": "set_qty", "target": target, "qty": qty})
        elif t == "bundle_start":
            actions.append({"type": "bundle_start"})
    control = raw.get("control") or "none"
    if control not in ("none", "done", "confirm_yes", "confirm_no",
                       "cancel", "menu", "greeting"):
        control = "none"
    if not actions and control == "none":
        return None
    return {"actions": actions, "control": control}


def _cart_desc(convo, e):
    parts = []
    for it in convo.items:
        if isinstance(it, e.OrderItem):
            parts.append(f"{it.quantity}x {it.name} ({it.milk} milk)")
        else:
            parts.append(f"bundle ({it.milk} milk): {', '.join(it.flavors)}")
    return "; ".join(parts)


def try_hybrid_reply(convo, text):
    """Return the hybrid reply, or None to fall back to the rule engine."""
    try:
        return _try_hybrid_reply(convo, text)
    except Exception:
        return None  # the rule engine always stays as the safety net


def _try_hybrid_reply(convo, text):
    e = _engine()
    menu = e.MENU
    if convo.state in ("BUNDLE_BUILDER", "BREAKROOM", "DONE"):
        return None  # the engine's sub-flows already handle these crisply

    # Per-message language detection, mirroring the engine's own behavior.
    detect = getattr(e, "detect_language", None)
    if detect:
        convo.lang = detect(text, default=convo.default_lang)
    elif not convo.lang:
        convo.lang = convo.default_lang
    lang = convo.lang or "es"

    api_key = (os.environ.get("GEMINI_API_KEY", "").strip()
               if _test_parse_fn is None else "test")
    if not api_key:
        return None  # no key configured -> pure rule engine

    system = _build_prompt(menu, _cart_desc(convo, e), convo.state)
    if _test_parse_fn is not None:
        raw = _test_parse_fn(system, text)
    else:
        raw = _call_gemini(system, text, api_key)
    intent = _validate(raw, menu)
    if intent is None:
        return None
    return _apply(convo, intent, e, lang)


def _apply(convo, intent, e, lang):
    actions = intent["actions"]
    control = intent["control"]
    menu = e.MENU

    if control == "cancel":
        reset = getattr(e, "reset_conversation", None)
        if reset:
            reset(convo)
        else:
            convo.items = []
            convo.state = "GREETING"
        return ("Pedido cancelado. ¿Empezamos de nuevo? Dime qué te gustaría."
                if lang == "es" else
                "Order cancelled. Want to start over? Tell me what you'd like.")
    if control == "menu":
        return e.menu_text()

    if any(a["type"] == "bundle_start" for a in actions):
        convo.state = "BUNDLE_BUILDER"
        convo.pending_bundle_milk = None
        return ("¡Buena elección! ¿El bundle de leche entera ($14) o de avena ($17)?"
                if lang == "es" else
                "Great choice! Whole milk bundle ($14) or oat milk bundle ($17)?")

    if convo.state == "GREETING":
        if not actions and control in ("none", "greeting"):
            return None  # let the engine greet
        convo.state = "COLLECTING"

    if convo.state == "CONFIRMING":
        if control == "confirm_yes":
            convo.state = "BREAKROOM"
            if lang == "es":
                return (f"¡Perfecto! Entregamos a Kaiser Baldwin Park los "
                        f"{e.DELIVERY_DAYS_ES}. 🏥\n"
                        "¿A qué departamento / break room lo llevamos?")
            return (f"Great! We deliver to Kaiser Baldwin Park on "
                    f"{e.DELIVERY_DAYS_EN}. 🏥\n"
                    "Which department / break room should we deliver to?")
        if control == "confirm_no":
            convo.state = "COLLECTING"
            convo.items = []
            return ("Sin problema, empecemos de nuevo. ¿Qué te gustaría ordenar?"
                    if lang == "es" else
                    "No problem, let's start over. What would you like?")
        if not actions:
            return None

    added = []
    changed = False
    milk_unspecified = False
    for a in actions:
        if a["type"] == "add":
            milk = a["milk"] or "whole"
            if a["milk"] is None and a["name"] != "classic black americano":
                milk_unspecified = True
            existing = next((i for i in convo.items
                             if isinstance(i, e.OrderItem)
                             and i.name == a["name"] and i.milk == milk), None)
            if existing:
                existing.quantity += a["qty"]
            else:
                convo.items.append(e.OrderItem(
                    name=a["name"], milk=milk, quantity=a["qty"],
                    unit_price=menu[a["name"]][milk]))
            added.append(f"{a['qty']}x {a['name'].title()}")
            changed = True
        elif a["type"] == "change_milk":
            targets = [i for i in convo.items if isinstance(i, e.OrderItem)
                       and (a["target"] is None or i.name == a["target"])
                       and i.name != "classic black americano"]
            for it in targets:
                it.milk = a["milk"]
                it.unit_price = menu[it.name][a["milk"]]
            changed = changed or bool(targets)
        elif a["type"] == "remove":
            before = len(convo.items)
            if a["target"]:
                convo.items = [i for i in convo.items
                                if not (isinstance(i, e.OrderItem)
                                        and i.name == a["target"])]
            elif convo.items:
                convo.items.pop()
            changed = changed or len(convo.items) != before
        elif a["type"] == "set_qty":
            targets = [i for i in convo.items if isinstance(i, e.OrderItem)
                       and (a["target"] is None or i.name == a["target"])]
            if targets and len({i.name for i in targets}) == 1:
                if a["qty"] == 0:
                    convo.items = [i for i in convo.items if i not in targets]
                else:
                    targets[0].quantity = a["qty"]
                    convo.items = [i for i in convo.items
                                   if i is targets[0] or i not in targets]
                changed = True

    if control == "done":
        if not convo.items:
            return ("Aún no tengo ningún artículo. Escribe 'menu' para ver opciones."
                    if lang == "es" else
                    "No items yet. Type 'menu' to see options.")
        convo.state = "CONFIRMING"
        if lang == "es":
            return ("Tu pedido:\n" + e.summary_text(convo)
                    + "\n¿Es correcto? Responde 'sí' para confirmar o 'no' para corregirlo.")
        return ("Your order:\n" + e.summary_text(convo)
                + "\nIs that correct? Reply 'yes' to confirm or 'no' to change it.")

    if not changed:
        return None

    if convo.state == "CONFIRMING":
        convo.state = "COLLECTING"
    tail = ("\n¿Algo más? Escribe 'listo' para confirmar tu pedido."
            if lang == "es" else "\nAnything else? Type 'done' to confirm.")
    if added:
        head = (f"Anotado: {', '.join(added)}.\n" if lang == "es"
                else f"Got it: {', '.join(added)}.\n")
    else:
        head = ("¡Listo! Actualicé tu pedido ✅\n" if lang == "es"
                else "Done! Updated your order ✅\n")
    note = ""
    if milk_unspecified:
        note = ("\n☝️ Los puse con leche entera — dime 'de avena' si quieres cambiarla."
                if lang == "es" else
                "\n☝️ I put those as whole milk — say 'oat milk' if you'd like to switch.")
    if not convo.items:
        return head + ("Tu carrito quedó vacío. ¿Qué te gustaría ordenar?"
                       if lang == "es" else
                       "Your cart is empty now. What would you like to order?")
    return head + e.summary_text(convo) + note + tail
