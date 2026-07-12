"""Phase 3 of the graph-ETA plan: the residual GNN, one architecture spec per
condition, all sharing this module.

Every condition predicts a RESIDUAL on top of model-v2 (see graph_dataset.py):
the head concatenates the message-passing embedding with the raw node features
(a skip connection carrying v2_pred), so with zero graph signal the model can
fall back to "v2 was right, residual ~ 0".

  Graph A: SAGEConv over FOLLOWS only, 2 layers        (local same-line)
  Graph B: SAGEConv over FOLLOWS + SHARES, 2 layers     (local junctions)
  Graph C: SAGEConv over FOLLOWS + SHARES, 4 layers,     (network-wide, deeper)
           + jumping-knowledge + inter-layer residuals + edge dropout,
           the standard mitigations for the oversmoothing/oversquashing that
           deep message passing on a sparse graph invites (the plan flags this
           as a real reason C might underperform B even so).

Layer choice — GraphSAGE (inductive: serving-time trains are never seen in
training), wrapped in HeteroConv so each relation gets its own weights and
"drop shares" is a literal config change (Graph A). Baseline needs no model
(residual := 0) and is handled in graph_experiment.py, not here.
"""
import torch
import torch.nn.functional as F
from torch import nn
from torch_geometric.nn import HeteroConv, SAGEConv

REL_FOLLOWS = ("train", "follows", "train")
REL_SHARES = ("train", "shares", "train")

CONDITIONS = {
    "graph_a": {"relations": [REL_FOLLOWS], "layers": 2, "jk": False, "residual": False, "edge_dropout": 0.0},
    "graph_b": {"relations": [REL_FOLLOWS, REL_SHARES], "layers": 2, "jk": False, "residual": False, "edge_dropout": 0.0},
    "graph_c": {"relations": [REL_FOLLOWS, REL_SHARES], "layers": 4, "jk": True, "residual": True, "edge_dropout": 0.1},
}


def _drop_edges(edge_index_dict, p, training):
    if not training or p <= 0:
        return edge_index_dict
    out = {}
    for rel, ei in edge_index_dict.items():
        if ei.size(1) == 0:
            out[rel] = ei
            continue
        mask = torch.rand(ei.size(1), device=ei.device) >= p
        out[rel] = ei[:, mask]
    return out


class ResidualHeteroGNN(nn.Module):
    def __init__(self, in_dim, config, hidden=48):
        super().__init__()
        self.relations = config["relations"]
        self.num_layers = config["layers"]
        self.jk = config["jk"]
        self.residual = config["residual"]
        self.edge_dropout = config["edge_dropout"]

        self.convs = nn.ModuleList()
        for li in range(self.num_layers):
            din = in_dim if li == 0 else hidden
            self.convs.append(HeteroConv(
                {rel: SAGEConv((din, din), hidden) for rel in self.relations},
                aggr="sum",
            ))

        # head input: skip connection (raw node features) + final embedding.
        # JK concatenates every layer's embedding instead of only the last.
        emb_dim = hidden * self.num_layers if self.jk else hidden
        self.head = nn.Sequential(
            nn.Linear(in_dim + emb_dim, hidden), nn.ReLU(),
            nn.Linear(hidden, 1),
        )

    def forward(self, data):
        x = data["train"].x
        h = x
        edge_index_dict = _drop_edges(data.edge_index_dict, self.edge_dropout, self.training)
        layer_outs = []
        for conv in self.convs:
            h_new = conv({"train": h}, edge_index_dict)["train"]
            h_new = F.relu(h_new)
            if self.residual and h_new.shape == h.shape:
                h_new = h_new + h
            h = h_new
            layer_outs.append(h)
        emb = torch.cat(layer_outs, dim=-1) if self.jk else h
        return self.head(torch.cat([x, emb], dim=-1)).squeeze(-1)


def make_model(in_dim, condition):
    return ResidualHeteroGNN(in_dim, CONDITIONS[condition])


def train_one(model, train_graphs, val_graphs, epochs=40, lr=1e-3, patience=6, batch=16, log=print):
    """Train a condition's model over snapshot graphs. Huber loss on the
    residual; early-stop on the temporal val slice. Graphs are processed a few
    per optimizer step (accumulated) — simple + robust vs. HeteroData batching
    with the custom per-graph attrs we carry."""
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    best_val, best_state, stale = float("inf"), None, 0
    for ep in range(epochs):
        model.train()
        opt.zero_grad()
        total, seen = 0.0, 0
        for i, g in enumerate(train_graphs):
            pred = model(g)
            loss = F.huber_loss(pred, g["train"].y, delta=30.0)
            loss.backward()
            total += loss.item() * g["train"].y.numel()
            seen += g["train"].y.numel()
            if (i + 1) % batch == 0 or i == len(train_graphs) - 1:
                opt.step()
                opt.zero_grad()
        val = evaluate_mae(model, val_graphs)["residual_mae"]
        if val < best_val - 0.1:
            best_val, best_state, stale = val, {k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            stale += 1
        if ep % 5 == 0 or stale >= patience:
            log(f"      epoch {ep:2d}: train_huber={total/max(1,seen):.1f} val_res_mae={val:.1f}s")
        if stale >= patience:
            break
    if best_state:
        model.load_state_dict(best_state)
    return model


@torch.no_grad()
def evaluate_mae(model, graphs):
    """Residual-prediction MAE (how well the GNN predicts v2's error)."""
    model.eval()
    err = 0.0
    n = 0
    for g in graphs:
        pred = model(g)
        err += float((pred - g["train"].y).abs().sum())
        n += g["train"].y.numel()
    return {"residual_mae": err / max(1, n), "n": n}


if __name__ == "__main__":
    # tiny self-test: a 3-node snapshot, overfit a batch (loss -> ~0).
    from torch_geometric.data import HeteroData

    g = HeteroData()
    g["train"].x = torch.randn(3, 10)
    g["train"].y = torch.tensor([50.0, -20.0, 5.0])
    g["train", "follows", "train"].edge_index = torch.tensor([[0, 1], [1, 2]])
    g["train", "shares", "train"].edge_index = torch.zeros((2, 0), dtype=torch.long)
    for cond in CONDITIONS:
        m = make_model(10, cond)
        m = train_one(m, [g], [g], epochs=200, patience=200, log=lambda *_: None)
        mae = evaluate_mae(m, [g])["residual_mae"]
        print(f"  {cond}: overfit residual_mae = {mae:.2f} (should be ~0)")
