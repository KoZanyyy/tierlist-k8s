const os = require("os");
const path = require("path");
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");

const PORT = Number(process.env.PORT) || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017";
const MONGO_DB = process.env.MONGO_DB || "tierlist";
const TITLE = process.env.TITLE || "Tier list";
// Éléments ajoutés au premier démarrage, séparés par des virgules
const SEED_ITEMS = (process.env.SEED_ITEMS || "").split(",").map((s) => s.trim()).filter(Boolean);

const TIERS = { S: 5, A: 4, B: 3, C: 2, D: 1 };

let client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 3000 });
const items = () => client.db(MONGO_DB).collection("items");

const app = express();
app.use(express.json());

// Nom du pod qui a répondu, affiché en bas de la page
app.use((req, res, next) => {
  res.set("X-Served-By", os.hostname());
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/livez", (req, res) => res.json({ status: "ok" }));

app.get("/healthz", async (req, res) => {
  try {
    await client.db("admin").command({ ping: 1 });
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "mongo indisponible" });
  }
});

app.get("/api/config", (req, res) => res.json({ title: TITLE, servedBy: os.hostname() }));

// Classement : la moyenne des votes donne le tier de chaque élément
app.get("/api/items", async (req, res, next) => {
  try {
    const voter = String(req.query.voter || "");
    const list = await items().find().sort({ createdAt: 1 }).toArray();
    res.json(list.map((item) => {
      const scores = Object.values(item.votes || {});
      const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const tier = average === null ? null
        : Object.keys(TIERS).find((t) => TIERS[t] <= Math.round(average));
      const mine = item.votes?.[voter];
      return {
        _id: item._id,
        name: item.name,
        votes: scores.length,
        average,
        tier,
        myVote: Object.keys(TIERS).find((t) => TIERS[t] === mine) || null,
      };
    }));
  } catch (err) {
    next(err);
  }
});

app.post("/api/items", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name || name.length > 40) return res.status(400).json({ error: "nom entre 1 et 40 caractères" });
    await items().insertOne({ name, key: name.toLowerCase(), votes: {}, createdAt: new Date() });
    res.status(201).json({ name });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "cet élément existe déjà" });
    next(err);
  }
});

// Un vote par personne et par élément : voter à nouveau remplace l'ancien vote
app.put("/api/items/:id/vote", async (req, res, next) => {
  try {
    const voter = String(req.body?.voter || "");
    const tier = String(req.body?.tier || "");
    // L'identifiant sert de clé dans le document : on n'accepte que lettres, chiffres et tirets
    if (!/^[a-z0-9-]{8,40}$/.test(voter)) return res.status(400).json({ error: "votant invalide" });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "id invalide" });

    const update = tier in TIERS
      ? { $set: { [`votes.${voter}`]: TIERS[tier] } }
      : { $unset: { [`votes.${voter}`]: "" } }; // tier vide : on retire son vote
    const { matchedCount } = await items().updateOne({ _id: new ObjectId(req.params.id) }, update);
    if (!matchedCount) return res.status(404).json({ error: "élément introuvable" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "erreur serveur" });
});

// Connexion à Mongo, retentée tant que la base n'est pas prête.
// Le client est recréé à chaque essai : après un échec, le driver ne retente plus de lui-même.
async function connect() {
  for (;;) {
    try {
      await client.connect();
      console.log("Connecté à MongoDB");
      break;
    } catch (err) {
      console.error("MongoDB injoignable, nouvel essai dans 5 s :", err.message);
      await client.close().catch(() => {});
      client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  // L'index unique évite les doublons, y compris si plusieurs pods démarrent en même temps
  await items().createIndex({ key: 1 }, { unique: true });
  if (SEED_ITEMS.length && (await items().countDocuments()) === 0) {
    const docs = SEED_ITEMS.map((name) => ({ name, key: name.toLowerCase(), votes: {}, createdAt: new Date() }));
    await items().insertMany(docs, { ordered: false }).catch(() => {});
  }
}
connect();

const server = app.listen(PORT, () => console.log(`Écoute sur le port ${PORT}`));

process.on("SIGTERM", () => {
  server.close(() => client.close().finally(() => process.exit(0)));
});
