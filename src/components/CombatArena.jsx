import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, Sword, Shield, Zap, Heart, Clock, Star } from 'lucide-react';
import { fatalFlaws, weaponTypes, weaponMasteryValues, specialAbilities } from '../gameData.js';
import { randomInt } from '../utils/helpers.js';

const TURN_DELAY_MS = 1200;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Builds the per-match cooldown / uses tracker for a character's special ability.
const buildAbilityStates = (character) => {
  if (character.initialAbilityStates && Object.keys(character.initialAbilityStates).length) {
    return character.initialAbilityStates;
  }
  const ability = specialAbilities.find(sa => sa.name === character["Special Ability"]);
  if (!ability) return {};
  return { [ability.name]: { cooldown: 0, usesLeft: ability.usesPerMatch === -1 ? -1 : ability.usesPerMatch } };
};

// Permanent in-combat penalties coming from a character's fatal flaw.
const flawPenalties = (character, side) => {
  const flaw = fatalFlaws.find(f => f.name === character["Fatal Flaw"]);
  const effect = flaw?.combatEffect;
  if (!effect?.statPenalty || effect.duration !== -1) return [];
  return [{ type: "statPenalty", stats: effect.statPenalty, duration: -1, id: `flaw_${side}` }];
};

const isAbilityReady = (state) => !state || (state.cooldown <= 0 && state.usesLeft !== 0);

const CombatArena = ({ player, opponent, onClose, onCombatEnd }) => {
  const [currentPlayerHP, setCurrentPlayerHP] = useState(player.currentHP);
  const [currentOpponentHP, setCurrentOpponentHP] = useState(opponent.currentHP);
  const [combatTurn, setCombatTurn] = useState(1);
  const [currentAttackerId, setCurrentAttackerId] = useState(null);
  const [logMessages, setLogMessages] = useState([]);
  const [playerAbilityStates, setPlayerAbilityStates] = useState(() => buildAbilityStates(player));
  const [opponentAbilityStates, setOpponentAbilityStates] = useState(() => buildAbilityStates(opponent));
  const [playerBuffsDebuffs, setPlayerBuffsDebuffs] = useState(() => [...(player.activeBuffs || []), ...flawPenalties(player, 'player')]);
  const [opponentBuffsDebuffs, setOpponentBuffsDebuffs] = useState(() => [...(opponent.activeBuffs || []), ...flawPenalties(opponent, 'opponent')]);
  const [showAbilitySelection, setShowAbilitySelection] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [combatOver, setCombatOver] = useState(false);

  const logRef = useRef(null);
  const resolvingRef = useRef(false);
  const aiTurnScheduledRef = useRef(0);
  const mountedRef = useRef(true);

  const isPlayerTurn = currentAttackerId === 'player';

  const addLog = useCallback((message) => {
    setLogMessages(prev => [...prev, message]);
  }, []);

  const getEffectiveStats = useCallback((baseStats = {}, buffsDebuffs = []) => {
    const effectiveStats = { ...baseStats };
    buffsDebuffs.forEach(effect => {
      if (effect.type === "statPenalty" && effect.stats) {
        Object.entries(effect.stats).forEach(([stat, value]) => {
          effectiveStats[stat] = Math.max(0, (effectiveStats[stat] || 0) + value);
        });
      } else if ((effect.type === "statPenalty" || effect.type === "statBoost") && effect.stat) {
        effectiveStats[effect.stat] = Math.max(0, (effectiveStats[effect.stat] || 0) + effect.value);
      }
    });
    return effectiveStats;
  }, []);

  // Defending, shields and flaws that modify damage taken.
  const applyDefenderModifiers = useCallback((damage, defender, defenderStats, attackTypeElement) => {
    let finalDamage = damage;
    if (defender.activeBuffs.some(buff => buff.type === 'defending')) {
      const defenseBonus = (defenderStats.Durability || 0) + (defenderStats.Speed || 0) + (defenderStats.CombatSkill || 0);
      finalDamage *= (1 - Math.min(0.75, defenseBonus / 400));
      addLog(`${defender.name} is defending and blunts the blow.`);
    }
    const shield = defender.activeBuffs.find(buff => buff.type === 'damageReduction');
    if (shield) {
      finalDamage *= (1 - shield.value);
      addLog(`${defender.name}'s shield absorbs part of the damage.`);
    }
    const flaw = fatalFlaws.find(f => f.name === defender["Fatal Flaw"]);
    if (flaw?.combatEffect?.opponentDamageBoost && attackTypeElement && flaw.combatEffect.appliesToType === attackTypeElement) {
      finalDamage *= (1 + flaw.combatEffect.opponentDamageBoost);
      addLog(`${defender.name}'s ${flaw.name} makes the ${attackTypeElement} attack hit harder!`);
    }
    return Math.max(1, Math.round(finalDamage));
  }, [addLog]);

  const calculatePhysicalDamage = useCallback((attacker, defender, ability = null) => {
    const attackerStats = getEffectiveStats(attacker.Stats, attacker.activeBuffs);
    const defenderStats = getEffectiveStats(defender.Stats, defender.activeBuffs);

    let baseDamage = (attackerStats.Strength || 0) / 5;
    if (attacker["Weapon Yes/No"] === "Yes") {
      baseDamage += weaponTypes.find(w => w.name === attacker["Weapon Type"])?.baseDamage || 0;
      baseDamage += weaponMasteryValues[attacker["Weapon Mastery"]]?.damageBonus || 0;
    }
    if (ability?.power > 0) baseDamage += ability.power;

    const reduced = baseDamage * (1 - (defenderStats.Durability || 0) / 200);
    return applyDefenderModifiers(reduced, defender, defenderStats, ability?.element || null);
  }, [getEffectiveStats, applyDefenderModifiers]);

  const calculateMagicalDamage = useCallback((attacker, defender, ability) => {
    const attackerStats = getEffectiveStats(attacker.Stats, attacker.activeBuffs);
    const defenderStats = getEffectiveStats(defender.Stats, defender.activeBuffs);

    const baseDamage = (attackerStats.Intelligence || 0) / 5 + (ability?.power || 0);
    const reduced = baseDamage * (1 - (defenderStats.Durability || 0) / 200);
    return applyDefenderModifiers(reduced, defender, defenderStats, ability?.element || null);
  }, [getEffectiveStats, applyDefenderModifiers]);

  const getDodgeChance = useCallback((attacker, defender) => {
    const attackerStats = getEffectiveStats(attacker.Stats, attacker.activeBuffs);
    const defenderStats = getEffectiveStats(defender.Stats, defender.activeBuffs);
    const agilityBonus = Math.max(0, ((defenderStats.Speed || 0) - (attackerStats.Speed || 0)) / 10);
    const masteryPenalty = attacker["Weapon Yes/No"] === "Yes" ? (weaponMasteryValues[attacker["Weapon Mastery"]]?.dodgePenalty || 0) : 0;
    const dodgeBuff = defender.activeBuffs.find(buff => buff.type === 'dodgeBoost');
    const buffBonus = dodgeBuff ? dodgeBuff.value * 100 : 0;
    return Math.max(0, Math.min(95, 5 + agilityBonus - masteryPenalty + buffBonus));
  }, [getEffectiveStats]);

  // Initial combat setup: decide who strikes first.
  useEffect(() => {
    mountedRef.current = true;
    const playerSpeed = player.Stats?.Speed || 0;
    const opponentSpeed = opponent.Stats?.Speed || 0;
    let firstAttackerId = 'player';
    if (opponentSpeed > playerSpeed) firstAttackerId = 'opponent';
    else if (opponentSpeed === playerSpeed) firstAttackerId = randomInt(0, 1) === 0 ? 'player' : 'opponent';

    setLogMessages([`⚔️ Combat begins! ${firstAttackerId === 'player' ? player.name : opponent.name} strikes first!`]);
    [[player, 'player'], [opponent, 'opponent']].forEach(([character, side]) => {
      if (flawPenalties(character, side).length) {
        setLogMessages(prev => [...prev, `💀 ${character.name}'s ${character["Fatal Flaw"]} weakens them for this fight.`]);
      }
    });
    setCurrentAttackerId(firstAttackerId);
    return () => { mountedRef.current = false; };
  }, [player, opponent]);

  // Scroll combat log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logMessages]);

  const endTurn = useCallback(() => {
    if (!mountedRef.current) return;
    setCombatTurn(prev => prev + 1);
    setCurrentAttackerId(prev => (prev === 'player' ? 'opponent' : 'player'));
    setShowAbilitySelection(false);
    resolvingRef.current = false;
    setIsResolving(false);
  }, []);

  const handleTurn = useCallback(async (requestedAction, abilityName = null) => {
    if (resolvingRef.current || combatOver || !currentAttackerId) return;
    resolvingRef.current = true;
    setIsResolving(true);
    setShowAbilitySelection(false);

    let action = requestedAction;
    const attackerIsPlayer = currentAttackerId === 'player';
    const attackerBase = attackerIsPlayer ? player : opponent;
    const defenderBase = attackerIsPlayer ? opponent : player;
    const setAttackerBuffs = attackerIsPlayer ? setPlayerBuffsDebuffs : setOpponentBuffsDebuffs;
    const setDefenderBuffs = attackerIsPlayer ? setOpponentBuffsDebuffs : setPlayerBuffsDebuffs;
    const setAttackerAbilityStates = attackerIsPlayer ? setPlayerAbilityStates : setOpponentAbilityStates;

    // Work on local copies so damage, healing and the victory check all see the same numbers.
    let attackerHP = attackerIsPlayer ? currentPlayerHP : currentOpponentHP;
    let defenderHP = attackerIsPlayer ? currentOpponentHP : currentPlayerHP;
    const abilityStates = Object.fromEntries(
      Object.entries(attackerIsPlayer ? playerAbilityStates : opponentAbilityStates).map(([k, v]) => [k, { ...v }])
    );

    // The attacker's own timed effects tick down at the start of their turn.
    let attackerBuffs = (attackerIsPlayer ? playerBuffsDebuffs : opponentBuffsDebuffs)
      .map(effect => (effect.duration === -1 ? effect : { ...effect, duration: effect.duration - 1 }))
      .filter(effect => effect.duration !== 0);
    let defenderBuffs = attackerIsPlayer ? opponentBuffsDebuffs : playerBuffsDebuffs;

    const attacker = () => ({ ...attackerBase, activeBuffs: attackerBuffs });
    const defender = () => ({ ...defenderBase, activeBuffs: defenderBuffs });

    addLog(`🎯 Turn ${combatTurn}: ${attackerBase.name}'s move`);

    const stun = attackerBuffs.find(effect => effect.type === 'stunned');
    if (stun) {
      addLog(`⏸️ ${attackerBase.name} is frozen in time and loses the turn!`);
      action = 'skip';
    }

    const flaw = fatalFlaws.find(f => f.name === attackerBase["Fatal Flaw"])?.combatEffect;
    if (flaw && action !== 'skip') {
      if (flaw.selfDamageChance && Math.random() < flaw.selfDamageChance) {
        attackerHP = Math.max(0, attackerHP - flaw.selfDamageAmount);
        addLog(`💀 ${attackerBase.name}'s ${attackerBase["Fatal Flaw"]} causes ${flaw.selfDamageAmount} self-damage!`);
      }
      if (flaw.forcedAttackChance && action !== 'attack' && Math.random() < flaw.forcedAttackChance) {
        action = 'attack';
        addLog(`😤 ${attackerBase.name}'s ${attackerBase["Fatal Flaw"]} forces a reckless attack!`);
      }
      if (flaw.abilityFailChance && action === 'ability' && Math.random() < flaw.abilityFailChance) {
        addLog(`❌ ${attackerBase.name}'s ${attackerBase["Fatal Flaw"]} makes the ability fizzle!`);
        action = 'skip';
      }
    }

    const chosenAbility = abilityName ? specialAbilities.find(ab => ab.name === abilityName) : null;
    let usedAbilityName = null;

    if (action === 'ability' && chosenAbility) {
      const state = abilityStates[chosenAbility.name];
      if (!isAbilityReady(state)) {
        addLog(`⏳ ${chosenAbility.name} is not ready yet.`);
      } else {
        addLog(`✨ ${attackerBase.name} uses ${chosenAbility.name}!`);
        const effect = chosenAbility.effect || {};

        if (effect.selfDamage) {
          attackerHP = Math.max(0, attackerHP - effect.selfDamage);
          addLog(`🩸 ${attackerBase.name} pays ${effect.selfDamage} HP for power.`);
        }
        if (effect.tempStrBoost) {
          attackerBuffs = [...attackerBuffs, { type: "statBoost", stat: "Strength", value: effect.tempStrBoost, duration: effect.duration + 1 }];
          addLog(`💪 ${attackerBase.name} gains ${effect.tempStrBoost} Strength for ${effect.duration} turns!`);
        }
        if (effect.damageReduction) {
          attackerBuffs = [...attackerBuffs, { type: "damageReduction", value: effect.damageReduction, duration: effect.duration }];
          addLog(`🛡️ ${attackerBase.name} raises a shield (${effect.damageReduction * 100}% damage reduction).`);
        }
        if (effect.highDodgeChance) {
          attackerBuffs = [...attackerBuffs, { type: "dodgeBoost", value: effect.highDodgeChance, duration: effect.duration }];
          addLog(`💨 ${attackerBase.name} becomes very hard to hit!`);
        }
        if (effect.revive) {
          attackerBuffs = [...attackerBuffs, { type: "revive", value: effect.hpRestore, duration: -1 }];
          addLog(`🔥 ${attackerBase.name} will rise again with ${effect.hpRestore * 100}% HP if defeated.`);
        }
        if (effect.skipOpponentTurns) {
          defenderBuffs = [...defenderBuffs, { type: "stunned", duration: effect.skipOpponentTurns + 1 }];
          addLog(`⏸️ ${defenderBase.name} loses the next ${effect.skipOpponentTurns} turns!`);
        }

        if (chosenAbility.type === "healing" && chosenAbility.power < 0) {
          const healed = Math.min(attackerBase.maxHP, attackerHP + Math.abs(chosenAbility.power)) - attackerHP;
          attackerHP += healed;
          addLog(`💚 ${attackerBase.name} heals ${healed} HP.`);
        } else if (chosenAbility.type === "magical" || (chosenAbility.type === "physical" && chosenAbility.power > 0)) {
          let damage = chosenAbility.type === "magical"
            ? calculateMagicalDamage(attacker(), defender(), chosenAbility)
            : calculatePhysicalDamage(attacker(), defender(), chosenAbility);
          if (effect.damageBoost) damage = Math.round(damage * effect.damageBoost);
          defenderHP = Math.max(0, defenderHP - damage);
          addLog(`💥 ${chosenAbility.name} deals ${damage} damage to ${defenderBase.name}!`);
        } else if (!Object.keys(effect).length) {
          addLog(`🌀 ${attackerBase.name} repositions, looking for an opening.`);
        }

        usedAbilityName = chosenAbility.name;
        if (state) {
          state.cooldown = chosenAbility.cooldown;
          if (state.usesLeft > 0) state.usesLeft -= 1;
        }
      }
    } else if (action === 'attack') {
      const dodgeChance = getDodgeChance(attacker(), defender());
      if (randomInt(1, 100) <= dodgeChance) {
        addLog(`💨 ${defenderBase.name} dodges the attack!`);
      } else {
        const damage = calculatePhysicalDamage(attacker(), defender());
        defenderHP = Math.max(0, defenderHP - damage);
        addLog(`⚔️ ${attackerBase.name} hits ${defenderBase.name} for ${damage} damage!`);
      }
    } else if (action === 'defend') {
      attackerBuffs = [...attackerBuffs, { type: "defending", duration: 1 }];
      addLog(`🛡️ ${attackerBase.name} takes a defensive stance.`);
    }

    // Cooldowns recover at the end of each of the attacker's turns (not on the turn the ability was used).
    Object.entries(abilityStates).forEach(([name, state]) => {
      if (name !== usedAbilityName && state.cooldown > 0) state.cooldown -= 1;
    });

    // A revive effect saves a defeated fighter once.
    const tryRevive = (buffs, character, hp) => {
      if (hp > 0) return { buffs, hp };
      const revive = buffs.find(b => b.type === 'revive');
      if (!revive) return { buffs, hp };
      addLog(`🔥 ${character.name} rises from the ashes!`);
      return { buffs: buffs.filter(b => b !== revive), hp: Math.round(character.maxHP * revive.value) };
    };
    ({ buffs: attackerBuffs, hp: attackerHP } = tryRevive(attackerBuffs, attackerBase, attackerHP));
    ({ buffs: defenderBuffs, hp: defenderHP } = tryRevive(defenderBuffs, defenderBase, defenderHP));

    setAttackerBuffs(attackerBuffs);
    setDefenderBuffs(defenderBuffs);
    setAttackerAbilityStates(abilityStates);
    const playerHP = attackerIsPlayer ? attackerHP : defenderHP;
    const opponentHP = attackerIsPlayer ? defenderHP : attackerHP;
    setCurrentPlayerHP(playerHP);
    setCurrentOpponentHP(opponentHP);

    if (playerHP <= 0 || opponentHP <= 0) {
      const winner = playerHP <= 0 ? 'opponent' : 'player';
      setCombatOver(true);
      addLog(`🏁 ${winner === 'player' ? player.name : opponent.name} is victorious!`);
      await wait(TURN_DELAY_MS);
      if (mountedRef.current) onCombatEnd(winner, opponent);
      return;
    }

    await wait(TURN_DELAY_MS);
    endTurn();
  }, [player, opponent, currentAttackerId, combatTurn, combatOver, currentPlayerHP, currentOpponentHP,
      playerAbilityStates, opponentAbilityStates, playerBuffsDebuffs, opponentBuffsDebuffs,
      addLog, calculatePhysicalDamage, calculateMagicalDamage, getDodgeChance, onCombatEnd, endTurn]);

  // Opponent AI: exactly one decision per opponent turn.
  useEffect(() => {
    if (currentAttackerId !== 'opponent' || combatOver || resolvingRef.current) return;
    if (aiTurnScheduledRef.current === combatTurn) return;
    aiTurnScheduledRef.current = combatTurn;

    const ability = specialAbilities.find(sa => sa.name === opponent["Special Ability"]);
    const abilityState = ability ? opponentAbilityStates[ability.name] : null;
    const hpRatio = currentOpponentHP / opponent.maxHP;
    const playerHpRatio = currentPlayerHP / player.maxHP;

    let aiAction = 'attack';
    if (ability && combatTurn > 1 && isAbilityReady(abilityState)) {
      if (ability.type === 'healing') {
        if (hpRatio < 0.5) aiAction = 'ability';
      } else if (ability.type === 'defensive') {
        if (hpRatio < 0.6) aiAction = 'ability';
      } else if (ability.type === 'magical' || ability.power > 0) {
        if (playerHpRatio > 0.3 || randomInt(0, 1) === 0) aiAction = 'ability';
      } else if (randomInt(0, 2) === 0) {
        aiAction = 'ability';
      }
    }
    if (aiAction === 'attack' && hpRatio < 0.4 && randomInt(0, 2) === 0) {
      aiAction = 'defend';
    }

    // Not cleared on re-render: the turn guard above already prevents a second decision.
    setTimeout(() => handleTurn(aiAction, aiAction === 'ability' ? ability.name : null), TURN_DELAY_MS);
  }, [currentAttackerId, combatTurn, combatOver, handleTurn, opponent, player, currentOpponentHP, currentPlayerHP, opponentAbilityStates]);

  const playerHPPercent = (currentPlayerHP / player.maxHP) * 100;
  const opponentHPPercent = (currentOpponentHP / opponent.maxHP) * 100;

  return (
    <div className="fixed inset-0 bg-black/95 flex items-center justify-center z-50 p-4">
      <div className="bg-gradient-to-br from-fantasy-dark via-gray-900 to-fantasy-dark rounded-2xl shadow-2xl p-6 border-2 border-mystical-ruby w-full max-w-6xl h-5/6 flex flex-col backdrop-blur-sm">
        
        {/* Header */}
        <div className="text-center mb-6">
          <h2 className="text-4xl font-bold text-transparent bg-gradient-to-r from-mystical-ruby to-mystical-gold bg-clip-text font-fantasy flex items-center justify-center gap-3">
            <Sword size={40} className="text-mystical-ruby animate-glow" />
            ⚔️ Arena of Legends ⚔️
            <Shield size={40} className="text-mystical-gold animate-glow" />
          </h2>
          <p className="text-mystical-silver font-serif mt-2">Turn {combatTurn} • {isPlayerTurn ? "Your Turn" : "Opponent's Turn"}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-grow overflow-hidden">
          
          {/* Player Character */}
          <div className={`bg-gradient-to-br from-mystical-emerald/20 to-mystical-sapphire/20 rounded-xl p-6 flex flex-col items-center border-2 transition-all duration-300 ${currentAttackerId === 'player' ? 'border-mystical-gold shadow-lg shadow-mystical-gold/50' : 'border-mystical-emerald/50'}`}>
            <div className="w-20 h-20 bg-gradient-to-br from-mystical-emerald to-mystical-sapphire rounded-full mb-4 flex items-center justify-center text-2xl font-bold border-2 border-mystical-gold">
              🛡️
            </div>
            <h3 className="text-2xl font-bold text-mystical-gold mb-2 font-fantasy">{player.name}</h3>
            <div className="text-center mb-4">
              <p className="text-lg text-mystical-silver flex items-center gap-2">
                <Heart size={20} className="text-red-400" />
                {currentPlayerHP}/{player.maxHP}
              </p>
              <div className="w-full bg-gray-700 rounded-full h-4 mt-2 border border-mystical-gold/30">
                <div
                  className="bg-gradient-to-r from-red-500 to-green-500 h-4 rounded-full transition-all duration-500"
                  style={{ width: `${playerHPPercent}%` }}
                ></div>
              </div>
            </div>
            
            {/* Player Buffs/Debuffs */}
            <div className="flex flex-wrap gap-2 justify-center">
              {playerBuffsDebuffs.map((buff, idx) => (
                <span key={idx} className="px-2 py-1 bg-mystical-sapphire/30 rounded-md text-xs text-mystical-silver border border-mystical-sapphire/50">
                  {buff.type} {buff.duration !== -1 ? `(${buff.duration})` : ''}
                </span>
              ))}
            </div>
          </div>

          {/* Combat Log */}
          <div className="bg-gradient-to-br from-fantasy-dark to-gray-900 rounded-xl p-4 border-2 border-mystical-purple/50 overflow-hidden flex flex-col">
            <h3 className="text-xl font-bold text-mystical-purple mb-3 text-center font-fantasy flex items-center justify-center gap-2">
              <Star size={24} />
              Battle Chronicle
            </h3>
            <div className="flex-grow overflow-y-auto bg-gray-800/50 rounded-lg p-3 border border-mystical-purple/30" ref={logRef}>
              {logMessages.map((msg, index) => (
                <p key={index} className="text-sm text-mystical-silver mb-1 flex items-start gap-2">
                  <ChevronRight size={14} className="text-mystical-gold mt-0.5 flex-shrink-0" />
                  <span>{msg}</span>
                </p>
              ))}
            </div>
          </div>

          {/* Opponent Character */}
          <div className={`bg-gradient-to-br from-mystical-ruby/20 to-mystical-purple/20 rounded-xl p-6 flex flex-col items-center border-2 transition-all duration-300 ${currentAttackerId === 'opponent' ? 'border-mystical-gold shadow-lg shadow-mystical-gold/50' : 'border-mystical-ruby/50'}`}>
            <div className="w-20 h-20 bg-gradient-to-br from-mystical-ruby to-mystical-purple rounded-full mb-4 flex items-center justify-center text-2xl font-bold border-2 border-mystical-gold">
              ⚔️
            </div>
            <h3 className="text-2xl font-bold text-mystical-gold mb-2 font-fantasy">{opponent.name}</h3>
            <div className="text-center mb-4">
              <p className="text-lg text-mystical-silver flex items-center gap-2">
                <Heart size={20} className="text-red-400" />
                {currentOpponentHP}/{opponent.maxHP}
              </p>
              <div className="w-full bg-gray-700 rounded-full h-4 mt-2 border border-mystical-gold/30">
                <div
                  className="bg-gradient-to-r from-red-500 to-green-500 h-4 rounded-full transition-all duration-500"
                  style={{ width: `${opponentHPPercent}%` }}
                ></div>
              </div>
            </div>
            
            {/* Opponent Buffs/Debuffs */}
            <div className="flex flex-wrap gap-2 justify-center">
              {opponentBuffsDebuffs.map((buff, idx) => (
                <span key={idx} className="px-2 py-1 bg-mystical-ruby/30 rounded-md text-xs text-mystical-silver border border-mystical-ruby/50">
                  {buff.type} {buff.duration !== -1 ? `(${buff.duration})` : ''}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Player Actions */}
        {isPlayerTurn && !isResolving && !combatOver && (
          <div className="mt-6 bg-gradient-to-r from-mystical-gold/20 to-mystical-silver/20 rounded-xl p-6 border border-mystical-gold/50">
            <h3 className="text-2xl font-bold text-mystical-gold mb-4 text-center font-fantasy">Choose Your Action</h3>
            <div className="flex justify-center gap-4 flex-wrap">
              <button
                onClick={() => handleTurn('attack')}
                className="px-6 py-3 bg-gradient-to-r from-mystical-ruby to-red-600 text-white rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 transform hover:scale-105 font-serif border border-mystical-ruby/50"
              >
                <div className="flex items-center gap-2">
                  <Sword size={20} />
                  Attack
                </div>
              </button>
              <button
                onClick={() => handleTurn('defend')}
                className="px-6 py-3 bg-gradient-to-r from-mystical-sapphire to-blue-600 text-white rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 transform hover:scale-105 font-serif border border-mystical-sapphire/50"
              >
                <div className="flex items-center gap-2">
                  <Shield size={20} />
                  Defend
                </div>
              </button>
              <button
                onClick={() => setShowAbilitySelection(true)}
                disabled={combatTurn === 1}
                className="px-6 py-3 bg-gradient-to-r from-mystical-purple to-purple-600 text-white rounded-xl shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105 font-serif border border-mystical-purple/50"
              >
                <div className="flex items-center gap-2">
                  <Zap size={20} />
                  Abilities
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Close Button */}
        <button
          onClick={onClose}
          className="mt-4 px-6 py-3 bg-gradient-to-r from-gray-600 to-gray-700 text-white text-lg font-bold rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 transform hover:scale-105 font-serif border border-gray-500"
        >
          Retreat from Battle
        </button>

        {/* Ability Selection Modal */}
        {showAbilitySelection && (
          <div className="absolute inset-0 bg-black/90 flex items-center justify-center p-4 rounded-2xl">
            <div className="bg-gradient-to-br from-fantasy-dark to-gray-900 rounded-xl shadow-2xl p-6 border-2 border-mystical-purple w-full max-w-lg">
              <h3 className="text-3xl font-bold text-mystical-gold text-center mb-6 font-fantasy">Choose Your Power</h3>
              <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                {player["Special Ability"] && player["Special Ability"] !== "None" ? (
                  (() => {
                    const playerAbility = specialAbilities.find(sa => sa.name === player["Special Ability"]);
                    const abilState = playerAbilityStates[playerAbility.name] || { cooldown: 0, usesLeft: playerAbility.usesPerMatch === -1 ? 999 : playerAbility.usesPerMatch };
                    const isDisabled = abilState.cooldown > 0 || (abilState.usesLeft !== -1 && abilState.usesLeft === 0);
                    const displayUses = playerAbility.usesPerMatch === -1 ? "∞" : abilState.usesLeft;
                    return (
                      <button
                        key={playerAbility.name}
                        onClick={() => handleTurn('ability', playerAbility.name)}
                        disabled={isDisabled}
                        className={`w-full text-left p-4 rounded-xl flex justify-between items-center transition-all duration-300 border-2
                          ${isDisabled ? 'bg-gray-700 text-gray-500 cursor-not-allowed border-gray-600' : 'bg-gradient-to-r from-mystical-purple/20 to-mystical-gold/20 hover:from-mystical-purple/30 hover:to-mystical-gold/30 text-mystical-silver border-mystical-purple/50 hover:border-mystical-gold'}`}
                      >
                        <div>
                          <span className="font-bold text-lg text-mystical-gold">{playerAbility.name}</span>
                          <p className="text-sm text-mystical-silver mt-1">
                            {playerAbility.type === "healing" ? `Heals ${Math.abs(playerAbility.power)} HP` : 
                             playerAbility.type === "physical" || playerAbility.type === "magical" ? `Deals ${playerAbility.power} damage` : 
                             playerAbility.type}
                          </p>
                        </div>
                        <div className="text-right text-sm">
                          <p className="flex items-center gap-1">
                            <Clock size={16} />
                            {abilState.cooldown}/{playerAbility.cooldown}
                          </p>
                          <p>Uses: {displayUses}{playerAbility.usesPerMatch !== -1 && `/${playerAbility.usesPerMatch}`}</p>
                        </div>
                      </button>
                    );
                  })()
                ) : (
                  <p className="text-center text-mystical-silver text-lg py-8">You have no special abilities to use.</p>
                )}
              </div>
              <button
                onClick={() => setShowAbilitySelection(false)}
                className="mt-6 w-full py-3 bg-gradient-to-r from-red-600 to-red-700 text-white rounded-xl hover:from-red-700 hover:to-red-800 transition-all duration-300 font-serif"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CombatArena;