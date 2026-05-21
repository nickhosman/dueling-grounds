import { updateDuelState, activeDuel } from "./main.js";
import { DuelApplication } from "./duel-application.js";

export class DuelHUD {
  static addButton(tokenHUD, html, tokenData) {
    const token = canvas.tokens.get(tokenData._id);
    if (!token?.isOwner) return; // Only show if the user owns the clicked token

    const isDuelActive = !!activeDuel;

    // Dynamically set the icon and tooltip based on the current state
    const iconClass = isDuelActive ? "fa-eye" : "fa-swords";
    const titleText = isDuelActive ? "Spectate/Join Active Duel" : "Initiate Duel";

    const buttonHtml = $(`
      <div class="control-icon dueling-grounds-hud-btn" title="${titleText}">
        <i class="fas ${iconClass}"></i>
      </div>
    `);

    buttonHtml.click(async (event) => {
      event.preventDefault();

      // If a duel is already running, just open the window and stop execution
      if (isDuelActive) {
        DuelApplication.syncAndRender();
        return;
      }

      // --- STANDARD INITIATION LOGIC ---
      const targets = Array.from(game.user.targets);
      if (targets.length !== 1) {
        ui.notifications.warn("You must target exactly one token to challenge to a duel.");
        return;
      }

      const targetToken = targets[0];

      const initialState = {
        attackerId: token.id,
        defenderId: targetToken.id,
        phase: "setup",
        rules: {
          type: "touches",
          target: 3
        },
        touches: {
          [token.id]: 0,
          [targetToken.id]: 0
        },
        advantage: {
          [token.id]: false,
          [targetToken.id]: false
        },
        damageRolled: false,
        winnerId: null,
        initiativeRolls: {},
        approach: {
          [token.id]: null,
          [targetToken.id]: null
        },
        bonuses: {
          [token.id]: 0,
          [targetToken.id]: 0
        },
        rolls: {
          [token.id]: null,
          [targetToken.id]: null
        },
        pressureStack: 0
      };

      updateDuelState(initialState);
    });

    $(html).find(".col.right").append(buttonHtml);
  }
}
