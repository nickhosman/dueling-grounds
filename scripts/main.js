import { DuelHUD } from "./duel-hud.js";
import { DuelApplication } from "./duel-application.js";

export let duelSocket;
export let activeDuel = null;

Hooks.once("init", () => {
  console.log("Dueling Grounds | Initializing Module");
});

Hooks.once("socketlib.ready", () => {
  duelSocket = socketlib.registerModule("dueling-grounds");
  duelSocket.register("syncDuelState", _onSyncDuelState);

  // NEW: Register the GM-only damage execution socket
  duelSocket.register("applyDamageAndProgress", _onApplyDamageAndProgress);
});

Hooks.on("renderTokenHUD", (tokenHUD, html, tokenData) => {
  DuelHUD.addButton(tokenHUD, html, tokenData);
});

function _onSyncDuelState(state) {
  activeDuel = state;
  if (!activeDuel) {
    DuelApplication.closeWindow();
    return;
  }
  DuelApplication.syncAndRender();
}

// NEW: Trusted GM-side function to mutate actor sheets and update state
async function _onApplyDamageAndProgress(defenderId, damageTotal, attackerId) {
  if (!game.user.isGM) return; // Security safeguard

  const defenderToken = canvas.tokens.get(defenderId);
  const defActor = defenderToken?.actor;

  if (defActor) {
    const currentHp = defActor.system.attributes.hp.value;
    const newHp = Math.max(0, currentHp - damageTotal);

    // The GM safely updates the database document
    await defActor.update({"system.attributes.hp.value": newHp});

    // Evaluate HP Threshold Win criteria
    const maxHp = defActor.system.attributes.hp.max;
    const limitHp = Math.floor(maxHp * activeDuel.rules.target);

    if (newHp <= limitHp) {
      activeDuel.phase = "finished";
      activeDuel.winnerId = attackerId;
    }
  }

  activeDuel.damageRolled = true;
  updateDuelState(activeDuel);
}

export function updateDuelState(newState) {
  activeDuel = newState;
  duelSocket.executeForEveryone("syncDuelState", activeDuel);
}
