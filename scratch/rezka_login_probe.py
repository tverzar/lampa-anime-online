"""Проба формы входа HDrezka: какие поля ждёт /ajax/login/ и что отвечает.

Запускается на сервере рядом с сервисом: берёт ту же сессию (Anubis + cookies),
чтобы проверить запрос в реальных условиях. Ключи здесь заведомо неверные —
важен только формат ответа.
"""
import json
import sys

sys.path.insert(0, "/opt/kino-extractor")
import kino_extractor as kx


def probe(fields, name):
    session = kx.RezkaSession()
    session.solve()
    status, body = session.request(
        session.base + "/ajax/login/",
        fields,
        {"X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/javascript, */*; q=0.01"},
        referer=session.base + "/",
    )
    text = body.strip().replace("\n", " ")[:220]
    print("%-28s HTTP %s | %s" % (name, status, text))
    return status, body


probe({"login_name": "probe_user_12345", "login_password": "probe_pass_12345", "login_not_save": "1"}, "login_name/login_password")
probe({"login": "probe_user_12345", "password": "probe_pass_12345", "remember": "1"}, "login/password")
