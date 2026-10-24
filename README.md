# Tier list collaborative

TP Docker / Kubernetes : une application web conteneurisée et ses manifestes de déploiement Kubernetes.

## Auteurs

- CAGNON Lény

## L'application

Une **tier list collaborative**. Chaque personne qui ouvre la page :

- peut ajouter un élément à classer ;
- vote S, A, B, C ou D pour chaque élément (recliquer sur son vote l'annule) ;
- voit le classement général : chaque élément est placé dans le tier qui correspond à la moyenne des votes (S = 5 … D = 1).

Pas besoin de compte : chaque navigateur reçoit un identifiant anonyme, ce qui donne un vote par personne et par élément. La page se rafraîchit toutes les 3 secondes pour afficher les votes des autres.

Le thème (titre et éléments de départ) se règle par variables d'environnement. Par défaut, c'est « Meilleurs plats savoyards ». En bas de page, le nom du pod qui a répondu permet de voir la répartition de charge entre les replicas.

### Architecture

```
navigateur ──► app (Node.js / Express) ×2 ──► mongo (MongoDB)
               page web + API REST              StatefulSet + volume persistant
```

| Conteneur | Image | Rôle |
|-----------|-------|------|
| `app`     | `tierlist` (construite à partir de `app/Dockerfile`) | Sert la page web et l'API REST. Sans état, donc plusieurs replicas possibles |
| `mongo`   | `mongo:7` (image officielle) | Stocke les éléments et les votes |

API REST :

| Méthode | URL | Description |
|---------|-----|-------------|
| `GET`  | `/api/config` | Titre de la tier list |
| `GET`  | `/api/items?voter=<id>` | Éléments, avec tier, moyenne, nombre de votes et vote de `<id>` |
| `POST` | `/api/items` | Ajoute un élément : `{ "name": "Raclette" }` |
| `PUT`  | `/api/items/:id/vote` | Vote : `{ "voter": "<id>", "tier": "S" }` (`"tier": ""` retire le vote) |
| `GET`  | `/healthz` | 200 si MongoDB répond, sinon 503 (readiness probe) |
| `GET`  | `/livez` | 200 tant que le serveur tourne (liveness probe) |

Variables d'environnement de `app` : `MONGO_URL`, `MONGO_DB` (`tierlist`), `TITLE`, `SEED_ITEMS` (éléments séparés par des virgules, ajoutés seulement si la base est vide), `PORT` (3000).

## Lancement local avec docker compose

```bash
docker compose up -d --build
```

Puis ouvrir <http://localhost:8080>. Arrêt : `docker compose down` (ajouter `-v` pour effacer les données).

## Déploiement sur Kubernetes

### Les manifestes (`k8s/`)

| Fichier | Contenu |
|---------|---------|
| `00-namespace.yaml`     | Namespace `tierlist` |
| `01-mongo-secret.yaml`  | Secret `mongo` : identifiants MongoDB, utilisés par Mongo et par l'application |
| `02-app-config.yaml`    | ConfigMap `app-config` : titre, éléments de départ, nom de la base |
| `10-mongo.yaml`         | Service headless `mongo` + StatefulSet `mongo` (1 replica, volume persistant de 1 Gi via `volumeClaimTemplates`, probes startup/liveness/readiness) |
| `20-app.yaml`           | Service `app` de type NodePort (port 30080) + Deployment `app` (2 replicas, probes, requests/limits) |
| `30-ingress.yaml`       | Ingress : `tierlist.local` → service `app` |
| `gateway/gateway.yaml`  | Facultatif : Gateway + HTTPRoute, alternative à l'Ingress avec la Gateway API |
| `gateway/envoy-gatewayclass.yaml` | Facultatif : GatewayClass pour Envoy Gateway (test sur minikube) |

Les fichiers sont numérotés pour que `kubectl apply -f k8s/` crée d'abord le namespace. Cette commande ne descend pas dans `k8s/gateway/` : la Gateway API ne s'applique qu'à la demande (voir plus bas).

Quelques choix :

- **MongoDB en StatefulSet** : le pod garde le même nom (`mongo-0`) et retrouve le même volume (PVC `data-mongo-0`) quand il est recréé, donc les votes ne sont pas perdus.
- **Configuration séparée de l'image** : le thème est dans un ConfigMap et les identifiants dans un Secret. L'URL de connexion est construite dans le Deployment à partir du Secret (`$(MONGO_USER)`, `$(MONGO_PASSWORD)`).
- **Probes de l'application** : la readiness (`/healthz`) vérifie MongoDB, donc un pod n'est mis dans le Service que si la base répond. La liveness (`/livez`) ne dépend pas de la base, pour qu'une panne de MongoDB ne fasse pas redémarrer l'application en boucle.
- **Probes de MongoDB** : la startup probe laisse jusqu'à 2 minutes au premier démarrage. Ensuite, la liveness (port TCP) redémarre le conteneur s'il ne répond plus, et la readiness (`mongosh ping`) vérifie que la base accepte les commandes.

### Avec minikube

```bash
# 1. Démarrer le cluster (et l'Ingress Controller si on veut utiliser l'Ingress)
minikube start
minikube addons enable ingress

# 2. Construire l'image directement dans minikube (pas besoin de registry)
minikube image build -t tierlist:1.0 app/

# 3. Déployer
kubectl apply -f k8s/

# 4. Vérifier : 2 pods app + mongo-0 en Running, PVC Bound
kubectl -n tierlist get pods,svc,pvc
```

> Si `kubectl apply` échoue sur l'Ingress avec `failed calling webhook "validate.nginx.ingress.kubernetes.io"`, le contrôleur ingress n'est pas encore prêt : attendre une minute et relancer la commande.

Pour accéder à l'application, au choix :

- `minikube service app -n tierlist` (ouvre le navigateur sur le NodePort) ;
- `kubectl -n tierlist port-forward svc/app 8080:80`, puis <http://localhost:8080> ;
- avec l'Ingress : `minikube tunnel` dans un autre terminal, ajouter `127.0.0.1 tierlist.local` à `/etc/hosts`, puis ouvrir <http://tierlist.local>.

Pour changer de thème, modifier `k8s/02-app-config.yaml` puis lancer `kubectl apply -f k8s/` et `kubectl -n tierlist rollout restart deployment/app`. Les éléments de départ ne sont ajoutés que si la base est vide.

### Variante : Gateway API au lieu de l'Ingress

`k8s/gateway/gateway.yaml` expose l'application avec une **Gateway** (listener HTTP sur le port 80, hôte `tierlist.local`, seules les routes du namespace `tierlist` acceptées) et une **HTTPRoute** (préfixe `/` → service `app`). Il faut un contrôleur Gateway API sur le cluster.

Sur minikube, avec Envoy Gateway :

```bash
# Contrôleur + CRDs de la Gateway API (nécessite helm)
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.2 \
     -n envoy-gateway-system --create-namespace
kubectl -n envoy-gateway-system wait --for=condition=available deploy/envoy-gateway --timeout=300s

# GatewayClass "eg", puis Gateway + HTTPRoute
kubectl apply -f k8s/gateway/
kubectl -n tierlist get gateway,httproute
```

Envoy crée un Service de type LoadBalancer pour la Gateway. Sur minikube, il reste en `<pending>`, et la Gateway en `Programmed=False`, tant que `minikube tunnel` n'est pas lancé. Pour tester sans tunnel :

```bash
SVC=$(kubectl -n envoy-gateway-system get svc -l gateway.envoyproxy.io/owning-gateway-name=tierlist -o name)
kubectl -n envoy-gateway-system port-forward $SVC 8090:80
curl -H 'Host: tierlist.local' http://localhost:8090/api/config
```

Sur un cluster qui a déjà un contrôleur, ne pas appliquer `envoy-gatewayclass.yaml`. Il suffit de mettre la bonne classe dans `gatewayClassName` (`kubectl get gatewayclass`) puis d'appliquer `gateway.yaml`.

### Sur un autre cluster

Il faut d'abord pousser l'image sur un registry accessible par le cluster :

```bash
docker build --platform linux/amd64 -t <registry>/tierlist:1.0 app/
docker push <registry>/tierlist:1.0
```

Ensuite, remplacer `image: tierlist:1.0` par `<registry>/tierlist:1.0` dans `k8s/20-app.yaml`, changer le mot de passe dans `k8s/01-mongo-secret.yaml`, adapter l'hôte et l'`ingressClassName` de `k8s/30-ingress.yaml`, puis lancer `kubectl apply -f k8s/`.

### Quelques tests

```bash
# Répartition de charge : chaque réponse indique le pod qui l'a servie (en-tête X-Served-By).
# Récupérer l'URL du service. Sous macOS, la commande reste ouverte : la lancer dans
# un autre terminal et copier l'URL affichée dans URL=...
URL=$(minikube service app -n tierlist --url)
for i in 1 2 3 4 5 6; do curl -s -D - -o /dev/null $URL/api/config | grep X-Served-By; done
# Un navigateur réutilise sa connexion, et un port-forward vise un seul pod :
# dans ces deux cas, c'est presque toujours le même pod qui répond.

# Tolérance aux pannes : les pods app sont recréés automatiquement
kubectl -n tierlist delete pod -l app=tierlist

# Persistance : les votes sont toujours là après la recréation de mongo-0
kubectl -n tierlist delete pod mongo-0

# Mise à l'échelle
kubectl -n tierlist scale deployment/app --replicas=4
```

### Suppression

```bash
kubectl delete -f k8s/
```

Supprimer le namespace supprime aussi le volume de MongoDB, donc les données, ainsi que la Gateway et l'HTTPRoute si elles ont été créées. La GatewayClass `eg` n'appartient à aucun namespace : la supprimer avec `kubectl delete -f k8s/gateway/envoy-gatewayclass.yaml`.
