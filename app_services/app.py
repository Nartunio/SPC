import os
from flask import Flask, jsonify
import psycopg2

app = Flask(__name__)

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
def ok():
    return "MRE Flask działa"

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
    return "OK"

@app.get("/db/add")
def db_add():
    with get_conn() as c, c.cursor() as cur:
        cur.execute("INSERT INTO demo_items(name) VALUES('hello') RETURNING id;")
        new_id = cur.fetchone()[0]
    return jsonify(id=new_id)

@app.get("/db/list")
def db_list():
    with get_conn() as c, c.cursor() as cur:
        cur.execute("SELECT id,name FROM demo_items ORDER BY id;")
        rows = cur.fetchall()
    return jsonify([{"id": r[0], "name": r[1]} for r in rows])