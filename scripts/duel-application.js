import { activeDuel, updateDuelState, duelSocket } from "./main.js";

export class DuelApplication extends Application {
  static instance = null;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "duel-grounds-app",
      title: "Active Duel",
      template: "modules/dueling-grounds/templates/duel-window.hbs",
      width: 450,
      height: "auto",
      resizable: false,
      minimizable: false
    });
  }

  static syncAndRender() {
    // If the activeDuel is null, don't try to render
    if (!activeDuel) return;

    if (!this.instance) {
      this.instance = new DuelApplication();
    }
    this.instance.render(true);
  }

  static closeWindow() {
    if (this.instance) {
      // Pass {force: true} to bypass our new confirmation dialog
      this.instance.close({force: true});
      this.instance = null;
    }
  }

  // Intercept the window closing action
  async close(options = {}) {
    // If the system forces the close (e.g., duel terminates normally), close immediately
    if (options.force) {
      return super.close(options);
    }

    if (activeDuel) {
      const myTokenId = this._getMyTokenId();
      const isParticipantOrGM = game.user.isGM || (myTokenId === activeDuel.attackerId) || (myTokenId === activeDuel.defenderId);

      if (isParticipantOrGM) {
        // Prompt Participants and GMs with a confirmation dialog
        return new Dialog({
          title: "Terminate Active Duel?",
          content: "<p>Are you sure you want to close this window? This will <strong>terminate the active duel</strong> for everyone involved.</p>",
          buttons: {
            terminate: {
              icon: '<i class="fas fa-skull"></i>',
              label: "Terminate Duel",
              callback: () => {
                updateDuelState(null);
                // We don't need to call super.close() here; updateDuelState(null) triggers closeWindow() automatically.
              }
            },
            cancel: {
              icon: '<i class="fas fa-times"></i>',
              label: "Keep Window Open"
            }
          },
          default: "cancel"
        }).render(true);
      } else {
        // Spectators can safely close their personal window without ending the duel
        return super.close(options);
      }
    }

    return super.close(options);
  }

  getData() {
    const state = foundry.utils.deepClone(activeDuel);
    const myTokenId = this._getMyTokenId();

    const attToken = canvas.tokens.get(state.attackerId);
    const defToken = canvas.tokens.get(state.defenderId);

    state.attackerName = attToken?.name || "Attacker";
    state.defenderName = defToken?.name || "Defender";
    state.isGM = game.user.isGM;

    // NEW: Extract Image paths for both combatants
    state.attackerImg = attToken?.document.texture.src || attToken?.actor?.img || "icons/svg/mystery-man.svg";
    state.defenderImg = defToken?.document.texture.src || defToken?.actor?.img || "icons/svg/mystery-man.svg";

    // NEW: Explicit spectator tracking flag
    state.isSpectator = (myTokenId === null);

    // --- START OF NEW ADDITIONS ---
    // Identity Flags for UI Highlighting
    state.isAttacker = (myTokenId === state.attackerId);
    state.isDefender = (myTokenId === state.defenderId);
    // --- END OF IDENTITY FLAGS ---

    state.attackerTouches = state.touches[state.attackerId] || 0;
    state.defenderTouches = state.touches[state.defenderId] || 0;
    state.attackerHp = attToken?.actor?.system.attributes.hp.value || 0;
    state.attackerMaxHp = attToken?.actor?.system.attributes.hp.max || 0;
    state.defenderHp = defToken?.actor?.system.attributes.hp.value || 0;
    state.defenderMaxHp = defToken?.actor?.system.attributes.hp.max || 0;

    state.rules = activeDuel.rules;

    // --- START OF READINESS CHECKS ---
    // Calculate Readiness based on Phase
    state.attackerReady = false;
    state.defenderReady = false;

    if (state.phase === "initiative") {
      state.attackerReady = !!state.initiativeRolls?.[state.attackerId];
      state.defenderReady = !!state.initiativeRolls?.[state.defenderId];
    } else if (state.phase === "approach") {
      state.attackerReady = !!state.approach[state.attackerId];
      state.defenderReady = !!state.approach[state.defenderId];
    } else if (state.phase === "clash") {
      state.attackerReady = !!state.rolls[state.attackerId];
      state.defenderReady = !!state.rolls[state.defenderId];
    }
    // --- END OF READINESS CHECKS ---

    // Guard evaluation checks against null spectator properties
    state.hasSubmittedApproach = myTokenId ? !!state.approach[myTokenId] : false;
    state.hasRolled = myTokenId ? !!state.rolls[myTokenId] : false;
    state.hasRolledInitiative = myTokenId ? !!state.initiativeRolls?.[myTokenId] : false;

    if (state.phase === "initiative") {
      state.initBonus = myTokenId ? this._getInitiativeBonus(myTokenId) : 0;
    }

    if (state.phase === "clash" || state.phase === "outcome") {
      if (state.isSpectator) {
        // Spectator view normalization: yourStance maps to Attacker, opponentStance maps to Defender
        state.yourStance = state.approach[state.attackerId];
        state.opponentStance = state.approach[state.defenderId];
        state.matchupBonus = 0;
        state.sheetBonus = 0;
        state.totalRollBonus = 0;
      } else {
        const oppTokenId = myTokenId === state.attackerId ? state.defenderId : state.attackerId;
        state.yourStance = state.approach[myTokenId];
        state.opponentStance = state.approach[oppTokenId];
        state.matchupBonus = state.bonuses[myTokenId];

        state.sheetBonus = this._calculateActorBonus(myTokenId, state.yourStance);
        state.isDefender = myTokenId === state.defenderId;
        state.pressurePenalty = state.isDefender ? state.pressureStack : 0;
        state.totalRollBonus = state.sheetBonus + state.matchupBonus - state.pressurePenalty;
        state.hasAdvantage = activeDuel.advantage?.[myTokenId] || false;
      }
    }

    if (state.phase === "outcome") {
      state.outcomeText = this._calculateOutcomeText();

      const attVal = state.rolls[state.attackerId];
      const defVal = state.rolls[state.defenderId];
      const isCleanHit = (attVal - defVal) >= 3;

      // MODIFIED: Ensure the damage button NEVER shows if the GM is a spectator
      if (state.rules.type === "hp" && isCleanHit && !state.damageRolled && !state.isSpectator) {
        state.showDamageButton = (myTokenId === state.attackerId);
        state.canAdvance = false;
      } else {
        state.showDamageButton = false;
        state.canAdvance = true;
      }
    }

    if (state.phase === "finished") {
      state.winnerName = canvas.tokens.get(state.winnerId)?.name || "Unknown Combatant";
      if (state.rules.type === "touches") {
        state.victoryDetails = `Achieved the target score of ${state.rules.target} successful hit touches.`;
      } else {
        const loserId = state.winnerId === state.attackerId ? state.defenderId : state.attackerId;
        const loserName = canvas.tokens.get(loserId)?.name || "Opponent";
        state.victoryDetails = `${loserName} was driven down below their designated percentage HP safety threshold.`;
      }
    }

    return state;
  }

  activateListeners(html) {
    super.activateListeners(html);
    const myTokenId = this._getMyTokenId();

    // Setup Phase Configuration Observers
    if (activeDuel.phase === "setup" && game.user.isGM) {
      html.find("#setup-rule-type").change((ev) => {
        const type = ev.currentTarget.value;
        activeDuel.rules.type = type;
        activeDuel.rules.target = type === "touches" ? 3 : 0.25; // Sensible format conversion resets
        updateDuelState(activeDuel);
      });

      html.find("#setup-rule-target, #setup-rule-target-hp").change((ev) => {
        activeDuel.rules.target = parseFloat(ev.currentTarget.value) || 0;
        updateDuelState(activeDuel);
      });

      html.find("#start-duel-setup-btn").click((ev) => {
        ev.preventDefault();
        activeDuel.phase = "initiative";
        activeDuel.initiativeRolls = {
          [activeDuel.attackerId]: null,
          [activeDuel.defenderId]: null
        };
        updateDuelState(activeDuel);
      });
    }

    // Phase 0 Listeners: Initiative Roll
    html.find("#roll-init-btn").click(async (ev) => {
      const initBonus = parseInt(ev.currentTarget.dataset.bonus) || 0;
      const rollFormula = `1d20 ${initBonus >= 0 ? '+' : ''} ${initBonus}`;
      const roll = await new Roll(rollFormula).evaluate();

      await roll.toMessage({ flavor: `${canvas.tokens.get(myTokenId).name} rolls for Duel Initiative!` });

      if (!activeDuel.initiativeRolls) activeDuel.initiativeRolls = {};
      activeDuel.initiativeRolls[myTokenId] = roll.total;

      const oppId = myTokenId === activeDuel.attackerId ? activeDuel.defenderId : activeDuel.attackerId;
      if (activeDuel.initiativeRolls[oppId]) {
        const myRoll = activeDuel.initiativeRolls[myTokenId];
        const oppRoll = activeDuel.initiativeRolls[oppId];

        if (myRoll === oppRoll) {
          activeDuel.initiativeRolls[myTokenId] = null;
          activeDuel.initiativeRolls[oppId] = null;
          ui.notifications.info("Initiative tied! Rerolling...");
        } else {
          if (myRoll > oppRoll) {
            activeDuel.attackerId = myTokenId;
            activeDuel.defenderId = oppId;
          } else {
            activeDuel.attackerId = oppId;
            activeDuel.defenderId = myTokenId;
          }
          activeDuel.phase = "approach";
        }
      }
      updateDuelState(activeDuel);
    });

    // Phase 1 Listeners: Stance Selection
    html.find(".stance-btn").click(ev => {
      const stance = ev.currentTarget.dataset.stance;
      activeDuel.approach[myTokenId] = stance;

      const oppId = myTokenId === activeDuel.attackerId ? activeDuel.defenderId : activeDuel.attackerId;
      if (activeDuel.approach[oppId]) {
        this._evaluateStances();
        activeDuel.phase = "clash";
      }
      updateDuelState(activeDuel);
    });

    // Phase 2 Listeners: Clash Dice Roll
    html.find("#roll-clash-btn").click(async (ev) => {
      const totalBonus = parseInt(ev.currentTarget.dataset.totalBonus) || 0;

      // Check if this token has an active advantage flag stored
      const hasAdvantage = activeDuel.advantage?.[myTokenId] || false;
      const diceFormula = hasAdvantage ? "2d8kh" : "1d8";
      const rollFormula = `${diceFormula} ${totalBonus >= 0 ? '+' : ''} ${totalBonus}`;

      const roll = await new Roll(rollFormula).evaluate();

      const flavorText = hasAdvantage
        ? `${canvas.tokens.get(myTokenId).name} rolls for the Clash with ADVANTAGE!`
        : `${canvas.tokens.get(myTokenId).name} rolls for the Clash!`;

      await roll.toMessage({ flavor: flavorText });

      // Consume the advantage flag on roll completion
      if (!activeDuel.advantage) activeDuel.advantage = {};
      activeDuel.advantage[myTokenId] = false;

      activeDuel.rolls[myTokenId] = roll.total;

      const oppId = myTokenId === activeDuel.attackerId ? activeDuel.defenderId : activeDuel.attackerId;
      if (activeDuel.rolls[oppId]) {
        activeDuel.phase = "outcome";
        this._checkForImmediateTouchVictory();
      }
      updateDuelState(activeDuel);
    });

    // Phase 3 Listeners: Damage Processing Interaction
    html.find("#roll-damage-btn").click(async () => {
      const attackerStance = activeDuel.approach[activeDuel.attackerId];
      const abilityMap = { "Strength": "str", "Dexterity": "dex", "Constitution": "con" };
      const actor = canvas.tokens.get(activeDuel.attackerId)?.actor;
      const mod = actor?.system.abilities[abilityMap[attackerStance]]?.mod || 0;

      // Player calculates their roll formula locally
      const dmgRoll = await new Roll(`1d8 + ${mod}`).evaluate();
      await dmgRoll.toMessage({ flavor: `${canvas.tokens.get(activeDuel.attackerId).name} rolls clean strike damage!` });

      // FIX: Instead of updating the actor data locally, delegate execution to the GM client
      duelSocket.executeAsGM("applyDamageAndProgress", activeDuel.defenderId, dmgRoll.total, activeDuel.attackerId);
    });

    html.find("#next-exchange-btn").click(() => {
      this._advanceNextExchange();
    });

    html.find("#end-duel-btn, #close-duel-final-btn").click(() => {
      updateDuelState(null);
    });
  }

  _getMyTokenId() {
    // 1. If the user is the GM, check for a hybrid or pure PvP setup
    if (game.user.isGM) {
      const attHasPlayerOwner = canvas.tokens.get(activeDuel.attackerId)?.actor?.hasPlayerOwner;
      const defHasPlayerOwner = canvas.tokens.get(activeDuel.defenderId)?.actor?.hasPlayerOwner;

      // PURE PvP: Both have player owners. GM is a spectator (owns neither participant identity)
      if (attHasPlayerOwner && defHasPlayerOwner) return null;

      // GM vs PC: GM automatically controls whichever token does NOT belong to a player
      if (attHasPlayerOwner && !defHasPlayerOwner) return activeDuel.defenderId;
      if (!attHasPlayerOwner && defHasPlayerOwner) return activeDuel.attackerId;
    }

    // 2. If the user is a standard player, route them to the token they own
    if (!game.user.isGM) {
      const attToken = canvas.tokens.get(activeDuel.attackerId);
      const defToken = canvas.tokens.get(activeDuel.defenderId);
      if (attToken?.isOwner) return activeDuel.attackerId;
      if (defToken?.isOwner) return activeDuel.defenderId;

      // FIX: If they are a standard player and own NEITHER token, they are a spectator.
      return null;
    }

    // 3. Fallback for GM Solo Testing / NPC vs NPC: Track active canvas selection
    const controlledTokens = canvas.tokens.controlled;
    if (controlledTokens.length === 1) {
      const controlledId = controlledTokens[0].id;
      if (controlledId === activeDuel.attackerId || controlledId === activeDuel.defenderId) {
        return controlledId;
      }
    }

    // 4. Ultimate fallback (Only reached by a GM running an NPC vs NPC duel with no tokens selected)
    return activeDuel.attackerId;
  }

  _calculateActorBonus(tokenId, stance) {
    const actor = canvas.tokens.get(tokenId)?.actor;
    if (!actor) return 0;
    const abilityMap = { "Strength": "str", "Dexterity": "dex", "Constitution": "con" };
    return (actor.system.abilities[abilityMap[stance]]?.mod || 0) + (actor.system.attributes.prof || 0);
  }

  _getInitiativeBonus(tokenId) {
    const actor = canvas.tokens.get(tokenId)?.actor;
    if (!actor) return 0;
    return actor.system.attributes?.init?.total ?? actor.system.abilities?.dex?.mod ?? 0;
  }

  _evaluateStances() {
    const attStance = activeDuel.approach[activeDuel.attackerId];
    const defStance = activeDuel.approach[activeDuel.defenderId];
    activeDuel.bonuses[activeDuel.attackerId] = 0;
    activeDuel.bonuses[activeDuel.defenderId] = 0;

    if (attStance === defStance) return;
    const winMap = { Dexterity: "Strength", Strength: "Constitution", Constitution: "Dexterity" };
    if (winMap[attStance] === defStance) {
      activeDuel.bonuses[activeDuel.attackerId] = 2;
    } else {
      activeDuel.bonuses[activeDuel.defenderId] = 2;
    }
  }

  _checkForImmediateTouchVictory() {
    const attVal = activeDuel.rolls[activeDuel.attackerId];
    const defVal = activeDuel.rolls[activeDuel.defenderId];

    if ((attVal - defVal) >= 3) {
      // Score point instantly
      activeDuel.touches[activeDuel.attackerId] = (activeDuel.touches[activeDuel.attackerId] || 0) + 1;

      // Evaluate Touches Win criteria
      if (activeDuel.rules.type === "touches" && activeDuel.touches[activeDuel.attackerId] >= activeDuel.rules.target) {
        activeDuel.phase = "finished";
        activeDuel.winnerId = activeDuel.attackerId;
      }
    }
  }

  _calculateOutcomeText() {
    const attVal = activeDuel.rolls[activeDuel.attackerId];
    const defVal = activeDuel.rolls[activeDuel.defenderId];
    const diff = attVal - defVal;
    const attName = canvas.tokens.get(activeDuel.attackerId).name;
    const defName = canvas.tokens.get(activeDuel.defenderId).name;

    let summary = `Attacker Roll: <strong>${attVal}</strong> vs Defender Roll: <strong>${defVal}</strong><br><br>`;

    if (diff >= 3) {
      return summary + `<strong>${attName} lands a clean strike!</strong> ${activeDuel.rules.type === 'hp' ? 'Damage must be applied.' : 'Point scored!'} Reroll initiative next round.`;
    } else if (diff > 0) {
      return summary + `<strong>${defName} successfully blocks.</strong> Pressure is mounting (+1 Penalty).`;
    } else if (diff === 0) {
      return summary + `<strong>Stalemate!</strong> Swords bounce evenly. Reset and reroll initiative.`;
    } else if (diff > -3) {
      return summary + `<strong>${defName} seizes initiative!</strong> Standard role reversal next exchange.`;
    } else {
      return summary + `<strong>Decisive Counter!</strong> ${defName} redirects momentum and carries Advantage into their attack swap.`;
    }
  }

  _advanceNextExchange() {
    const attVal = activeDuel.rolls[activeDuel.attackerId];
    const defVal = activeDuel.rolls[activeDuel.defenderId];
    const diff = attVal - defVal;
    const oldAtt = activeDuel.attackerId;
    const oldDef = activeDuel.defenderId;

    // Safety initialization
    if (!activeDuel.advantage) activeDuel.advantage = {};

    if (diff >= 3 || diff === 0) {
      activeDuel.pressureStack = 0;
      activeDuel.phase = "initiative";
      activeDuel.initiativeRolls = { [activeDuel.attackerId]: null, [activeDuel.defenderId]: null };

      // Clear out running advantage records on full neutral field round resets
      activeDuel.advantage[oldAtt] = false;
      activeDuel.advantage[oldDef] = false;
    } else if (diff > 0) {
      activeDuel.pressureStack += 1;
      activeDuel.phase = "approach";
    } else if (diff > -3) {
      // Defender wins by less than 3: Simple Role Swap
      activeDuel.pressureStack = 0;
      activeDuel.attackerId = oldDef;
      activeDuel.defenderId = oldAtt;
      activeDuel.phase = "approach";
    } else {
      // Decisive Counter: Defender wins by 3 or more
      activeDuel.pressureStack = 0;
      activeDuel.attackerId = oldDef;
      activeDuel.defenderId = oldAtt;
      activeDuel.phase = "approach";

      // Grant advantage to the old defender, who is now the new attacker
      activeDuel.advantage[oldDef] = true;
    }

    // Global variable cleaning
    activeDuel.damageRolled = false;
    activeDuel.approach[activeDuel.attackerId] = null;
    activeDuel.approach[activeDuel.defenderId] = null;
    activeDuel.rolls[activeDuel.attackerId] = null;
    activeDuel.rolls[activeDuel.defenderId] = null;
    activeDuel.bonuses[activeDuel.attackerId] = 0;
    activeDuel.bonuses[activeDuel.defenderId] = 0;

    updateDuelState(activeDuel);
  }
}
