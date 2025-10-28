#  MRE – Azure App Service + Flask + Azure Database for PostgreSQL
# 1) Deployment aplikacji w Pythonie na Azure App Service (Linux, Python 3.12).
#     - Serwer www uruchamiany przez Gunicorn (komenda startowa w App Service).
#2) Połączenie z zarządzaną bazą danych Azure Database for PostgreSQL.
#     - Dane dostępu NIE są w kodzie — używam zmiennych środowiskowych App Service:
#         PGHOST      – host PostgreSQL
#         PGPORT      – port (domyślnie 5432)
#         PGDATABASE  – nazwa bazy
#         PGUSER      – użytkownik
#         PGPASSWORD  – hasło użytkownika
#Minimalne API w Flask do demonstracji CRUD na tabeli demo_items.
#     - Tabela tworzona idempotentnie przez endpoint /db/init.
#     - Przykładowe dodanie rekordu „hello” przez /db/add.
#     - Podgląd wszystkich rekordów przez /db/list (JSON).
#Jak uruchamiałam na Azure:
#  - Kod w repo (gałąź app_services).
#  - App Service (Linux) + Python 3.12, zmienne środowiskowe ustawione w:
#      Aplikacja → Ustawienia → Zmienne środowiskowe.
#  - Komenda startowa : gunicorn --bind=0.0.0.0 --timeout 600 app_services.app:app
#
import os
from flask import Flask, jsonify, request, abort, render_template_string
import psycopg2

app = Flask(__name__)

#połaczenie z bazą
def get_conn():
    return psycopg2.connect(
        host=os.getenv("PGHOST"),
        port=int(os.getenv("PGPORT", "5432")),
        dbname=os.getenv("PGDATABASE", "postgres"),
        user=os.getenv("PGUSER"),
        password=os.getenv("PGPASSWORD"),
        sslmode="require",
        connect_timeout=5,
    )


@app.get("/")
def test():
    return "MRE Flask działa"


#tworzy tabelę jeśli nie ma
@app.get("/db/init")
def db_init():
    sql = """
    CREATE TABLE IF NOT EXISTS demo_items(
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL
    );
    """
    with get_conn() as c, c.cursor() as cur:
        cur.execute(sql)
    return "Created"

#dodaje rekord do demo_items
@app.get("/db/add")
def db_add():
    name = request.args.get("name", "hello")
    with get_conn() as c, c.cursor() as cur:
        cur.execute("INSERT INTO demo_items(name) VALUES(%s) RETURNING id;", (name,))
        new_id = cur.fetchone()[0]
    return jsonify(id=new_id)

#zwraca liste rekordów
@app.get("/db/list")
def db_list():
    with get_conn() as c, c.cursor() as cur:
        cur.execute("SELECT id,name FROM demo_items ORDER BY id;")
        rows = cur.fetchall()
    return jsonify([{"id": r[0], "name": r[1]} for r in rows])


PAGE = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>demo items</title>
</head>
<body style="font-family:sans-serif;margin:40px;max-width:720px;">
<h1>demo items</h1>

<form method="post" action="/items" style="margin-bottom:10px">
  <input name="name" placeholder="Name..." required />
  <button type="submit">Submit</button>
</form>

{% if msg %}
<div style="color:green">{{ msg }}</div>
{% endif %}

<table border="1" cellpadding="4" cellspacing="0">
  <tr><th>ID</th><th>Name</th></tr>
  {% for r in rows %}
    <tr><td>{{ r[0] }}</td><td>{{ r[1] }}</td></tr>
  {% endfor %}
</table>

<p style="margin-top:12px;font-size:12px;color:#666">
Endpoints: /db/init, /db/add?name=..., /db/list
</p>
</body>
</html>
"""

@app.route("/items", methods=["GET", "POST"])
def items():
    msg = None
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        if not name:
            abort(400, "name required")
        with get_conn() as c, c.cursor() as cur:
            cur.execute("INSERT INTO demo_items(name) VALUES(%s);", (name,))
        msg = "Dodano."

    with get_conn() as c, c.cursor() as cur:
        cur.execute("SELECT id,name FROM demo_items ORDER BY id;")
        rows = cur.fetchall()

    return render_template_string(PAGE, rows=rows, msg=msg)