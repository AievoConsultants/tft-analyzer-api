import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.post("/analyze_board", (req, res) => {
  const { image_b64, stage = "2-1" } = req.body || {};
  if (!image_b64) return res.status(400).json({ error: "image_b64 required" });

  res.json({
    phase: stage.startsWith("2-") ? "early" : stage >= "4-3" ? "late" : "mid",
    recommendation_style: "single_comp",
    suggestions: [
      {
        comp_id: "FRELJORD_HUNTER",
        name: "Freljord Hunter",
        fit_score: 0.89,
        why: ["You already have Ashe+Sejuani"],
        priority_items: {
          Ashe: {
            bis: [{ name: "Giant Slayer", icon: "/icons/items/giant_slayer.png" }]
          }
        },
        next_units: [{ name: "Hecarim", icon: "/icons/units/hecarim.png" }],
        level_curve: "6 @3-2, 7 @4-1, 8 @5-1",
        positioning_tip: "Corner Ashe; Sej front",
        confidence: "high"
      }
    ]
  });
});

export default app;
