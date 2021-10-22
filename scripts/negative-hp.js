import { libWrapper} from "../lib/shim.js";

const moduleName = "negative-hp";


Hooks.once("init", () => {
	// Open module API
	window.NegativeHP = NegativeHP;

	// Register module settings
	window.NegativeHP.registerSettings();
});

Hooks.once("setup", () => {
	// Override Token5e#_drawHP bar to draw negative HP in red
	libWrapper.register(moduleName, "CONFIG.Token.objectClass.prototype._drawHPBar", window.NegativeHP._drawHPBar, "MIXED");
	// Override Actor#applyDamage to re-clamp actor hp between -hp.max and hp.max + hp.tempMax
	libWrapper.register(moduleName, "CONFIG.Actor.documentClass.prototype.applyDamage", window.NegativeHP.applyDamage, "MIXED");
});

Hooks.once("ready", () => {
	// If midi-qol enabled, override automatic damage application to open HP clamp
	if (game.modules.get("midi-qol")?.active) socketlib.modules.get("midi-qol").functions.set("createReverseDamageCard", window.NegativeHP.createReverseDamageCard);

	// If tidy5e-sheet enabled, hook on sheet render to display death save input when hp < 0
	if (game.modules.get("tidy5e-sheet")?.active) Hooks.on("renderTidy5eSheet", window.NegativeHP.displayDeathSave);
});


class NegativeHP {

	static registerSettings() {
		game.settings.register(moduleName, "PCmode", {
			name: "PC Mode",
			hint: "Negative HP tracking will only be enabled for Player Characters.",
			config: true,
			type: Boolean,
			default: false,
			onChange: () => window.location.reload()
		});
	}

	static _drawHPBar(wrapped, number, bar, data) {
		if (this.actor.type === "npc" && game.settings.get(moduleName, "PCmode")) return wrapped(number, bar, data);

		// Extract health data
		let { value, max, temp, tempmax } = this.document.actor.data.data.attributes.hp;
		let negative = false;
		if (value < 0) negative = true;
		value = Math.abs(value);

		temp = Number(temp || 0);
		tempmax = Number(tempmax || 0);

		// Differentiate between effective maximum and displayed maximum
		const effectiveMax = Math.max(0, max + tempmax);
		let displayMax = max + (tempmax > 0 ? tempmax : 0);

		// Allocate percentages of the total
		const tempPct = Math.clamped(temp, 0, displayMax) / displayMax;
		const valuePct = Math.clamped(value, 0, effectiveMax) / displayMax;
		let colorPct = Math.clamped(value, 0, effectiveMax) / displayMax;
		if (negative) colorPct = 0;

		// Determine colors to use
		const blk = 0x000000;
		let hpColor = PIXI.utils.rgb2hex([(1 - (colorPct / 2)), colorPct, 0]);
		const c = CONFIG.DND5E.tokenHPColors;

		// Determine the container size (logic borrowed from core)
		const w = this.w;
		let h = Math.max((canvas.dimensions.size / 12), 8);
		if (this.data.height >= 2) h *= 1.6;
		const bs = Math.clamped(h / 8, 1, 2);
		const bs1 = bs + 1;

		// Overall bar container
		bar.clear()
		bar.beginFill(blk, 0.5).lineStyle(bs, blk, 1.0).drawRoundedRect(0, 0, w, h, 3);

		// Temporary maximum HP
		if (tempmax > 0) {
			const pct = max / effectiveMax;
			bar.beginFill(c.tempmax, 1.0).lineStyle(1, blk, 1.0).drawRoundedRect(pct * w, 0, (1 - pct) * w, h, 2);
		}

		// Maximum HP penalty
		else if (tempmax < 0) {
			const pct = (max + tempmax) / max;
			bar.beginFill(c.negmax, 1.0).lineStyle(1, blk, 1.0).drawRoundedRect(pct * w, 0, (1 - pct) * w, h, 2);
		}

		// Health bar
		bar.beginFill(hpColor, 1.0).lineStyle(bs, blk, 1.0).drawRoundedRect(0, 0, valuePct * w, h, 2)

		// Temporary hit points
		if (temp > 0) {
			bar.beginFill(c.temp, 1.0).lineStyle(0).drawRoundedRect(bs1, bs1, (tempPct * w) - (2 * bs1), h - (2 * bs1), 1);
		}

		// Set position
		let posY = (number === 0) ? (this.h - h) : 0;
		bar.position.set(0, posY);
	}

	static async applyDamage(wrapped, amount = 0, multiplier = 1) {
		if (this.type === "npc" && game.settings.get(moduleName, "PCmode")) return wrapped(amount, multiplier);

		amount = Math.floor(parseInt(amount) * multiplier);
		const hp = this.data.data.attributes.hp;

		// Deduct damage from temp HP first
		const tmp = parseInt(hp.temp) || 0;
		const dt = amount > 0 ? Math.min(tmp, amount) : 0;

		// Remaining goes to health
		const tmpMax = parseInt(hp.tempmax) || 0;
		const dh = Math.clamped(hp.value - (amount - dt), -hp.max, hp.max + tmpMax);

		// Update the Actor
		const updates = {
			"data.attributes.hp.temp": tmp - dt,
			"data.attributes.hp.value": dh
		};

		// Delegate damage application to a hook
		// TODO replace this in the future with a better modifyTokenAttribute function in the core
		const allowed = Hooks.call("modifyTokenAttribute", {
			attribute: "attributes.hp",
			value: amount,
			isDelta: false,
			isBar: true
		}, updates);
		return allowed !== false ? this.update(updates) : this;
	}

	static async createReverseDamageCard(data) {
		var traitList = { di: {}, dr: {}, dv: {} };
		const GMAction = await import('/modules/midi-qol/src/module/GMAction.js');
		GMAction.initGMActionSetup();

		const damageList = data.damageList;
		let actor;
		const timestamp = Date.now();
		let promises = [];
		let tokenIdList = [];
		let templateData = {
			damageApplied: ["yes", "yesCard"].includes(data.autoApplyDamage) ? "HP Updated" : "HP Not Updated",
			damageList: [],
			needsButtonAll: false
		};

		const midi = await import('/modules/midi-qol/src/midi-qol.js');
		const midi_settings = await import('/modules/midi-qol/src/module/settings.js');
		const utils = await import('/modules/midi-qol/src/module/utils.js');

		let EChelpers;
		if (game.modules.get("evasion-class")?.active) EChelpers = await import('/modules/evasion-class/scripts/helpers.js');

		for (let { tokenId, tokenUuid, actorId, actorUuid, oldHP, oldTempHP, newTempHP, tempDamage, hpDamage, totalDamage, appliedDamage, sceneId } of damageList) {

			const token = utils.MQfromUuid(tokenUuid);
			const hp = token.actor.data.data.attributes.hp;
			const value = Math.floor(appliedDamage);
			const dt = value > 0 ? Math.min(oldTempHP, value) : 0;
			let newHP;
			if (token.actor.type === "npc" && game.settings.get(moduleName, "PCmode")) newHP = Math.clamped(oldHP - (value - dt), 0, hp.max + (parseInt(hp.tempmax) || 0));
			else newHP = Math.clamped(oldHP - (value - dt), -hp.max, hp.max + (parseInt(hp.tempmax) || 0));
			hpDamage = hp.value - newHP;
			hpDamage = Math.abs(hpDamage); // fix for incorrect sign during healing(?)

			if (game.modules.get("evasion-class")?.active && token.getFlag("evasion-class", "reduced")) {
				// Get AR from actor and determine type (flat vs percent)
				let AR = EChelpers.getAR(token.actor);
				if (AR.includes("%")) AR = parseFloat(AR) / 100;
				else if (AR.includes(".")) AR = parseFloat(AR);
				else AR = parseInt(AR) || 10;

				// Reconstruct damageList properties with AR reduction
				// appliedDamage : original (full) damage
				const reducedAppliedDamage = Number.isInteger(AR) ? Math.max(0, appliedDamage - AR) : Math.floor(appliedDamage * (1 - AR));

				// Case 1: no tempDamage (i.e. no temp HP)
				if (!tempDamage) {
					hpDamage = reducedAppliedDamage;

					newHP = oldHP - reducedAppliedDamage;
				}
				// Case 2: reducedAppliedDamage doesn't break tempHP
				else if (oldTempHP >= reducedAppliedDamage) {
					tempDamage = reducedAppliedDamage;
					hpDamage = 0;

					newTempHP = oldTempHP - reducedAppliedDamage;
					newHP = oldHP;
				}
				// Case 3: reducedAppliedDamage breaks tempHP and into HP
				else if (oldTempHP < reducedAppliedDamage) {
					tempDamage = oldTempHP;
					hpDamage = reducedAppliedDamage - oldTempHP;

					newTempHP = 0;
					newHP = oldHP - hpDamage;
				}

				if (token.actor.type === "npc" && game.settings.get(moduleName, "PCmode")) newHP = Math.clamped(newHP, 0, hp.max + (parseInt(hp.tempmax) || 0));
				else newHP = Math.clamped(newHP, -hp.max, hp.max + (parseInt(hp.tempmax) || 0));
				appliedDamage = reducedAppliedDamage;

				await token.unsetFlag("evasion-class", "reduced");
			}

			let tokenDocument;
			if (tokenUuid) {
				tokenDocument = utils.MQfromUuid(tokenUuid);
				actor = tokenDocument.actor;
			}
			else
				actor = utils.MQfromActorUuid(actorUuid);
			if (!actor) {
				midi.warn(`GMAction: reverse damage card could not find actor to update HP tokenUuid ${tokenUuid} actorUuid ${actorUuid}`);
				continue;
			}

			// removed intended for check
			if (["yes", "yesCard"].includes(data.autoApplyDamage)) {
				if (newHP !== oldHP || newTempHP !== oldTempHP) {
					promises.push(actor.update({ "data.attributes.hp.temp": newTempHP, "data.attributes.hp.value": newHP, "flags.dae.damageApplied": appliedDamage }));
				}
			}
			tokenIdList.push({ tokenId, tokenUuid, actorUuid, actorId, oldTempHP: oldTempHP, oldHP, totalDamage: Math.abs(totalDamage), newHP, newTempHP });
			let img = tokenDocument?.data.img || actor.img;
			if (midi_settings.configSettings.usePlayerPortrait && actor.type === "character")
				img = actor?.img || tokenDocument?.data.img;
			if (VideoHelper.hasVideoExtension(img)) {
				//@ts-ignore - createThumbnail not defined
				img = await game.video.createThumbnail(img, { width: 100, height: 100 });
			}
			let listItem = {
				actorUuid,
				tokenId: tokenId ?? "none",
				displayUuid: actorUuid.replaceAll(".", ""),
				tokenUuid,
				tokenImg: img,
				hpDamage,
				tempDamage: newTempHP - oldTempHP,
				totalDamage: Math.abs(totalDamage),
				halfDamage: Math.abs(Math.floor(totalDamage / 2)),
				doubleDamage: Math.abs(totalDamage * 2),
				appliedDamage,
				absDamage: Math.abs(appliedDamage),
				tokenName: (tokenDocument?.name && midi_settings.configSettings.useTokenNames) ? tokenDocument.name : actor.name,
				dmgSign: appliedDamage < 0 ? "+" : "-",
				newHP,
				newTempHP,
				oldTempHP,
				oldHP,
				buttonId: tokenUuid
			};
			["di", "dv", "dr"].forEach(trait => {
				const traits = actor?.data.data.traits[trait];
				if (traits?.custom || traits?.value.length > 0) {
					//@ts-ignore CONFIG.DND5E
					listItem[trait] = (`${traitList[trait]}: ${traits.value.map(t => CONFIG.DND5E.damageResistanceTypes[t]).join(",").concat(" " + traits?.custom)}`);
				}
			});
			//@ts-ignore listItem
			templateData.damageList.push(listItem);
		}
		templateData.needsButtonAll = damageList.length > 1;
		//@ts-ignore
		const results = await Promise.allSettled(promises);
		midi.warn("GM action results are ", results);
		if (["yesCard", "noCard"].includes(data.autoApplyDamage)) {
			const content = await renderTemplate("modules/midi-qol/templates/damage-results.html", templateData);
			const speaker = ChatMessage.getSpeaker();
			speaker.alias = game.user?.name;
			let chatData = {
				user: game.user?.id,
				speaker: { scene: midi.getCanvas().scene?.id, alias: game.user?.name, user: game.user?.id },
				content: content,
				whisper: ChatMessage.getWhisperRecipients("GM").filter(u => u.active).map(u => u.id),
				type: CONST.CHAT_MESSAGE_TYPES.OTHER,
				flags: { "midiqol": { "undoDamage": tokenIdList } }
			};
			let message = await ChatMessage.create(chatData);
		}
	}

	static displayDeathSave(app, html, appData) {
		const actor = app.object;
		if (actor.data.data.attributes.hp.value > -1) return;

		const deathSaveDiv = html.find(`section.profile-wrap`).find(`div`)[0];
		const classes = deathSaveDiv.className.split(/\s+/);
		$(deathSaveDiv).removeClass(classes.find(c => c.includes("hp")));
		$(deathSaveDiv).addClass(`hp-0-0`);
	}
}
