const TIERS = ["S", "A", "B", "C", "D"];
const $ = (id) => document.getElementById(id);

// Identifiant anonyme du votant, gardé dans le navigateur (un vote par personne et par élément)
function voterId() {
  let id = null;
  try { id = localStorage.getItem("tierlist.voter"); } catch {}
  if (!id) {
    id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    try { localStorage.setItem("tierlist.voter", id); } catch {}
  }
  return id;
}
const voter = voterId();

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const pod = res.headers.get("X-Served-By");
  if (pod) $("pod").textContent = pod;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erreur ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function chip(item) {
  const div = document.createElement("div");
  div.className = "chip";
  div.textContent = item.name;
  const count = document.createElement("small");
  count.textContent = item.votes ? ` ${item.votes} vote${item.votes > 1 ? "s" : ""}` : "";
  div.append(count);
  return div;
}

function render(items) {
  // Classement général
  for (const tier of TIERS) {
    $(`tier-${tier}`).replaceChildren(...items.filter((i) => i.tier === tier)
      .sort((a, b) => b.average - a.average).map(chip));
  }
  const unranked = items.filter((i) => !i.tier);
  $("unranked").replaceChildren(...unranked.map(chip));
  $("unranked-box").hidden = unranked.length === 0;

  // Mes votes : un bouton par tier, celui choisi est mis en évidence
  $("votes").replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = item.name;
    li.append(name);
    for (const tier of TIERS) {
      const button = document.createElement("button");
      button.textContent = tier;
      button.dataset.tier = tier;
      button.className = item.myVote === tier ? "chosen" : "";
      button.title = item.myVote === tier ? "Retirer mon vote" : `Voter ${tier}`;
      // Recliquer sur son vote l'annule
      button.onclick = () => vote(item._id, item.myVote === tier ? "" : tier);
      li.append(button);
    }
    return li;
  }));
}

async function load() {
  render(await api("GET", `/api/items?voter=${voter}`));
}

function showError(err) {
  $("error").textContent = err ? err.message : "";
  $("error").hidden = !err;
}

async function vote(id, tier) {
  try {
    await api("PUT", `/api/items/${id}/vote`, { voter, tier });
    await load();
    showError(null);
  } catch (err) {
    showError(err);
  }
}

$("add-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("POST", "/api/items", { name: $("name").value });
    $("name").value = "";
    await load();
    showError(null);
  } catch (err) {
    showError(err);
  }
};

api("GET", "/api/config").then((config) => {
  $("title").textContent = config.title;
  document.title = config.title;
}).catch(() => {});

// Rafraîchissement régulier pour voir les votes des autres
load().catch(showError);
setInterval(() => load().catch(() => {}), 3000);
