
if (typeof performance == "undefined") {
    eval(`global.performance = require("perf_hooks").performance;`);
}

/** @template T @param {T[]} array */
const pick = array => array[~~(Math.random() * array.length)];

/**
 * @param {number} v 
 * @param {number} min 
 * @param {number} max 
 */
const clamp = (v, min, max) => v <= min ? min : v >= max ? max : v;

/**
 * @param {number} min 
 * @param {number} max 
 */
const range = (min, max) => Math.random() * (max - min) + min;

const Cell = require("./cell");
const QuadTree = require("./quadtree");
const Controller = require("../game/controller");
const Bot = require("../bot");

const DefaultSettings = {
    LEADERBOARD_TPS: 2,
    TIME_SCALE: 1,
    PHYSICS_TPS: 20,
    MAX_CELL_PER_TICK: 50,
    CELL_LIMIT: 65536,
    QUADTREE_MAX_ITEMS: 24,
    QUADTREE_MAX_LEVEL: 16,
    MAP_HW: 32767, // MAX signed short
    MAP_HH: 32767, // MAX signed short,
    SAFE_SPAWN_TRIES: 64,
    SAFE_SPAWN_RADIUS: 1.5,
    PELLET_COUNT: 1000,
    PELLET_SIZE: 10,
    VIRUS_PUSH: false,
    VIRUS_COUNT: 30,
    VIRUS_SIZE: 100,
    VIRUS_FEED_TIMES: 7,
    VIRUS_SPLIT_BOOST: 780,
    VIRUS_MONOTONE_POP: false,
    MOTHER_CELL_COUNT: 0,
    MOTHER_CELL_SIZE: 149,
    PLAYER_SPEED: 1.5,
    PLAYER_SPAWN_DELAY: 3000,
    PLAYER_AUTOSPLIT_SIZE: 1500,
    PLAYER_AUTOSPLIT_DELAY: 100,
    PLAYER_MAX_CELLS: 16,
    PLAYER_SPAWN_SIZE: 32,
    PLAYER_SPLIT_BOOST: 800,
    PLAYER_SPLIT_DIST: 40,
    PLAYER_SPLIT_CAP: 4,
    PLAYER_MIN_SPLIT_SIZE: 60,
    PLAYER_MIN_EJECT_SIZE: 60,
    PLAYER_NO_MERGE_DELAY: 650,
    PLAYER_NO_COLLI_DELAY: 650,
    PLAYER_NO_EJECT_DELAY: 200,
    PLAYER_NO_EJECT_POP_DEALY: 500,
    PLAYER_MERGE_TIME: 1,
    PLAYER_MERGE_INCREASE: 1,
    PLAYER_MERGE_NEW_VER: true,
    PLAYER_VIEW_SCALE: 1,
    PLAYER_VIEW_MIN: 4000,
    PLAYER_DEAD_DELAY: 5000,
    STATIC_DECAY: 1,
    DYNAMIC_DECAY: 1,
    DECAY_MIN: 1000,
    BOTS: 1,
    BOT_SPAWN_SIZE: 1000,
    EJECT_DISPERSION: 0.3,
    EJECT_SIZE: 38,
    EJECT_LOSS: 43,
    EJECT_BOOST: 780,
    EJECT_DELAY: 100, // ms
    EJECT_MAX_AGE: 10000,
    WORLD_RESTART_MULT: 0.75,
    WORLD_KILL_OVERSIZE: false,
    WORLD_OVERSIZE_MESSAGE: "${c.name} died from oversize",
    EAT_OVERLAP: 3,
    EAT_MULT: 1.140175425099138
}

const DEAD_CELL_TYPE = 251;
const MOTHER_CELL_TYPE = 252;
const VIRUS_TYPE = 253;
const PELLET_TYPE = 254;
const EJECTED_TYPE = 255;

/**
 * x (float) 4 bytes
 * y (float) 4 bytes
 * r (float) 4 bytes
 * type (player_id/cell type) 1 byte
 * flags (inside|updated|exist|etc) 1 byte
 * eatenBy 2 bytes
 * age 4 bytes
 * boost { 3 float } = 12 bytes
 */

module.exports = class Engine {

    /** @param {import("../game")} game */
    constructor(game) {
        this.game = game;
        this.options = Object.assign({}, DefaultSettings);
        this.collisions = 0;
        this.shouldRestart = false;

        /** @type {Bot[]} */
        this.bots = [];
    }
    
    /** @param {typeof DefaultSettings} options */
    setOptions(options) {
        Object.assign(this.options, options);
    }

    /** @param {ArrayBuffer|Buffer} wasm_buffer */
    async init(wasm_buffer) {
        if (this.wasm) return;

        this.__start = performance.now();
        this.__ltick = performance.now();

        // 60mb ram (way more than enough)
        this.memory = new WebAssembly.Memory({ initial: 1000 });

        // Load wasm module
        const module = await WebAssembly.instantiate(
            wasm_buffer, { env: { 
                memory: this.memory,
                powf: Math.pow,
                roundf: Math.round,
                unlock_line: id => this.game.controls[id].unlock(),
                log_magic: () => console.log("MAGIC"),
                log_compare: (a, b) => console.log(`Intersect: ${a}, Include: ${b}`),
                get_score: id => this.game.controls[id].score,
                get_line_a: id => this.game.controls[id].linearEquation[0],
                get_line_b: id => this.game.controls[id].linearEquation[1],
                get_line_c: id => this.game.controls[id].linearEquation[2],
            }
        });

        this.wasm = module.instance.exports;
        /** @type {number} */
        this.BYTES_PER_CELL = this.wasm.bytes_per_cell();
        this.bindBuffers();
    }

    bindBuffers() {
        
        /** @type {Set<number>[]} */
        this.counters = Array.from({ length: 256 }, _ => new Set());
        this.__next_cell_id = 1;

        // Fill 0 in case we are reusing the buffer
        new Uint32Array(this.memory.buffer).fill(0);

        // Default CELL_LIMIT uses 2mb ram
        this.cells = Array.from({ length: this.options.CELL_LIMIT }, (_, i) =>
            new Cell(new DataView(this.memory.buffer, i * this.BYTES_PER_CELL, this.BYTES_PER_CELL), i));
        this.cellCount = 0;
        
        this.tree = new QuadTree(this.cells, 0, 0, 
            this.options.MAP_HW, this.options.MAP_HH, 
            this.options.QUADTREE_MAX_LEVEL,
            this.options.QUADTREE_MAX_ITEMS);

        this.indices = 0;
        this.indicesPtr = this.BYTES_PER_CELL * this.options.CELL_LIMIT;
        this.resolveIndices = new DataView(this.memory.buffer, this.indicesPtr);

        // Not defined here since it's dynamically changed (after indices)
        this.treePtr = 0;
        this.treeBuffer = null;

        /** @type {number[]} */
        this.removedCells = [];
        /** @type {[number, boolean][]} */
        this.killArray = [];
        /** @type {number[]} */
        this.spawnArray = [];
    }

    get running() { return !!this.updateInterval; }

    start() {
        if (this.running) return;
        this.__ltick = performance.now();

        this.tickDelay = 1000 / this.options.PHYSICS_TPS;
        this.updateInterval = setInterval(() => {
            this.__now = performance.now();
            this.tick((this.__now - this.__ltick) * this.options.TIME_SCALE);
            this.__ltick = this.__now;
            this.usage = (performance.now() - this.__now) / this.tickDelay;
        }, this.tickDelay);

        this.lbDelay = 1000 / this.options.LEADERBOARD_TPS;
        this.leaderboardInterval = setInterval(() => {
            this.game.emit("leaderboard", this.leaderboard);
        }, this.lbDelay);
    }

    stop() {
        if (this.running) {
            clearInterval(this.updateInterval);
            clearInterval(this.leaderboardInterval);
        }
        this.updateInterval = null;
        this.leaderboardInterval = null;
    }

    restart() {
        this.shouldRestart = false;
        this.game.emit("restart");
        this.bindBuffers();
    }

    /** @param {number} dt */
    tick(dt) {

        if (this.shouldRestart) this.restart();

        // Has player
        if (this.game.handles > this.bots.length &&
            this.bots.length < this.options.BOTS)
            this.bots.push(new Bot(this.game));

        this.alivePlayers = this.game.controls.filter(c => c.alive && !(c.handle instanceof Bot));

        // No need to reserve space for indices now since we are only going to query it
        this.treePtr = this.BYTES_PER_CELL * this.options.CELL_LIMIT;
        this.treeBuffer = new DataView(this.memory.buffer, this.treePtr);
        // Serialize again so client can query viewport
        this.serialize();

        // Emit tick
        this.game.emit("tick");

        this.spawnCells();
        this.handleInputs(dt);
        this.updateIndices();
        this.updateCells(dt);
        this.updatePlayerCells(dt);
        this.updateTree();

        // Delayed kill, so the flags will be read after resolve and update quadtree
        for (const [id, replace] of this.killArray) 
            this.kill(id, replace);
        this.killArray = [];

        // Sort indices (because we added new cells and we need to sort by size)
        this.sortIndices();
        // Serialize quadtree, preparing for collision/eat resolution
        this.serialize();

        this.resolve();
        this.postResolve();

        this.leaderboard = this.game.controls.filter(c => c.alive).sort((a, b) => b.score - a.score);
    }

    spawnCells() {
        // Spawn "some" new cells
        for (let i = 0; i < this.options.MAX_CELL_PER_TICK; i++) {
            if (this.counters[PELLET_TYPE].size < this.options.PELLET_COUNT) {
                const point = this.getSafeSpawnPoint(this.options.PELLET_SIZE);
                this.newCell(point[0], point[1], this.options.PELLET_SIZE, PELLET_TYPE);
            } else break;
        }

        for (let i = 0; i < this.options.MAX_CELL_PER_TICK; i++) {
            if (this.counters[VIRUS_TYPE].size < this.options.VIRUS_COUNT) {
                const point = this.getSafeSpawnPoint(this.options.VIRUS_SIZE);
                this.newCell(point[0], point[1], this.options.VIRUS_SIZE, VIRUS_TYPE);
            } else break;
        }

        for (let i = 0; i < this.options.MAX_CELL_PER_TICK; i++) {
            if (this.counters[MOTHER_CELL_TYPE].size < this.options.MOTHER_CELL_COUNT) {
                const point = this.getSafeSpawnPoint(this.options.MOTHER_CELL_SIZE);
                this.newCell(point[0], point[1], this.options.MOTHER_CELL_SIZE, MOTHER_CELL_TYPE);
            } else break;
        }

        for (const id of this.spawnArray) {
            const c = this.game.controls[id];

            if (c.handle instanceof Bot) {
                const [x, y] = this.getSafeSpawnPoint(this.options.BOT_SPAWN_SIZE);
                this.newCell(x, y, this.options.BOT_SPAWN_SIZE, id);
            } else {
                const [x, y] = this.getPlayerSpawnPoint();
                this.newCell(x, y, this.options.PLAYER_SPAWN_SIZE, id);
            }

            this.game.emit("spawn", c);
            c.afterSpawn();
        }
        this.spawnArray = [];
    }

    handleInputs(dt) {
        for (const id in this.game.controls) {
            const controller = this.game.controls[id];
            if (!controller.handle) continue;
            
            // Split
            let attempts = this.options.PLAYER_SPLIT_CAP;
            while (controller.splitAttempts > 0 && attempts-- > 0) {
                for (const cell_id of [...this.counters[id]]) {
                    const cell = this.cells[cell_id];
                    if (this.counters[id].size >= this.options.PLAYER_MAX_CELLS) break;
                    if (cell.r < this.options.PLAYER_MIN_SPLIT_SIZE) continue;
                    let dx = controller.mouseX - cell.x;
                    let dy = controller.mouseY - cell.y;
                    let d = Math.sqrt(dx * dx + dy * dy);
                    if (d < 1) dx = 1, dy = 0, d = 1;
                    else dx /= d, dy /= d;
                    this.splitFromCell(cell, cell.r / Math.SQRT2, dx, dy, this.options.PLAYER_SPLIT_BOOST);
                }
                controller.splitAttempts--;
            }

            let ejected = 0;
            let maxEjectPerTick = dt / this.options.EJECT_DELAY;
            // Eject
            if (this.__now > controller.lastPoppedTick + this.options.PLAYER_NO_EJECT_POP_DEALY) {

                while (controller.lastEjectTick <= this.__now + dt && 
                    (controller.ejectAttempts > 0 || controller.ejectMarco) && 
                    maxEjectPerTick--) {
                    controller.ejectAttempts = Math.max(controller.ejectAttempts - 1, 0);
                    ejected++;
    
                    const LOSS = this.options.EJECT_LOSS * this.options.EJECT_LOSS;
                    for (const cell_id of [...this.counters[id]]) {
                        const cell = this.cells[cell_id];
                        if (cell.r < this.options.PLAYER_MIN_EJECT_SIZE) continue;
                        if (cell.age < this.options.PLAYER_NO_EJECT_DELAY) continue;
                        let dx = controller.mouseX - cell.x;
                        let dy = controller.mouseY - cell.y;
                        let d = Math.sqrt(dx * dx + dy * dy);
                        if (d < 1) dx = 1, dy = 0, d = 1;
                        else dx /= d, dy /= d;
                        const sx = cell.x + dx * cell.r;
                        const sy = cell.y + dy * cell.r;
                        const a = Math.atan2(dx, dy) - this.options.EJECT_DISPERSION + 
                            Math.random() * 2 * this.options.EJECT_DISPERSION;
                        this.newCell(sx, sy, this.options.EJECT_SIZE, EJECTED_TYPE, 
                            Math.sin(a), Math.cos(a), this.options.EJECT_BOOST);
                        cell.r = Math.sqrt(cell.r * cell.r - LOSS);
                        cell.updated = true;
                    }
    
                    controller.lastEjectTick = this.__now + ejected * this.options.EJECT_DELAY;
                }
            }

            // Idle spectate
            // if (!this.counters[id].size && !controller.spawn) {
            //     controller.viewportX = 0;
            //     controller.viewportY = 0;
            //     controller.viewportHW = 1920 / 2;
            //     controller.viewportHH = 1080 / 2;
            //     continue;
            // }

            if (controller.alive) {
                // Update viewport
                let size = 0, size_x = 0, size_y = 0;
                let x = 0, y = 0, score = 0, factor = 0;
                let min_x = this.options.MAP_HW, max_x = -this.options.MAP_HW;
                let min_y = this.options.MAP_HH, max_y = -this.options.MAP_HH;

                for (const cell_id of this.counters[id]) {
                    const cell = this.cells[cell_id];
                    x += cell.x * cell.r;
                    y += cell.y * cell.r;
                    min_x = cell.x < min_x ? cell.x : min_x;
                    max_x = cell.x > max_x ? cell.x : max_x;
                    min_y = cell.y < min_y ? cell.y : min_y;
                    max_y = cell.y > max_y ? cell.y : max_y;
                    score += cell.r * cell.r / 100;
                    size += cell.r;
                }

                controller.box.l = min_x;
                controller.box.r = max_x;
                controller.box.b = min_y;
                controller.box.t = max_y;

                size = size || 1;
                factor = Math.pow(this.counters[id].size + 50, 0.1);
                controller.viewportX = x / size;
                controller.viewportY = y / size;
                size = (factor + 1) * Math.sqrt(score * 100);
                size_x = size_y = Math.max(size, this.options.PLAYER_VIEW_MIN);
                size_x = Math.max(size_x, (controller.viewportX - min_x) * 1.75);
                size_x = Math.max(size_x, (max_x - controller.viewportX) * 1.75);
                size_y = Math.max(size_y, (controller.viewportY - min_y) * 1.75);
                size_y = Math.max(size_y, (max_y - controller.viewportY) * 1.75);
                controller.viewportHW = size_x * this.options.PLAYER_VIEW_SCALE;
                controller.viewportHH = size_y * this.options.PLAYER_VIEW_SCALE;
    
                controller.score = score;
                controller.maxScore = score > controller.maxScore ? score : controller.maxScore;
                if (controller.score > this.options.MAP_HH * this.options.MAP_HW / 100 * this.options.WORLD_RESTART_MULT) {
                    this.game.emit("oversize", controller);
                    if (this.options.WORLD_KILL_OVERSIZE) {
                        this.delayKill(id);
                    } else {
                        this.shouldRestart = true;
                    }
                }
            }

            // Spawn
            if (controller.spawn && (this.__now <= this.options.PLAYER_SPAWN_DELAY || 
                    this.__now >= controller.lastSpawnTick + this.options.PLAYER_SPAWN_DELAY)) {
                controller.spawn = false;
                controller.lastSpawnTick = this.__now;

                this.delayKill(controller.id, true);
                this.delaySpawn(controller.id);

            } else controller.spawn = false;
        }
    }

    delaySpawn(id) {
        this.spawnArray.push(id);
    }

    delayKill(id = 0, replace = false) {
        if (!this.game.controls[id].alive) return; // not alive, nothing to kill
        this.killArray.push([id, replace]);
    }

    updateIndices() {
        let offset = 0;
        for (let type = 0; type < this.counters.length; type++) {
            const iter = type ? this.counters[type] : this.removedCells;
            for (const cell_id of iter) {
                this.resolveIndices.setUint16(offset, cell_id, true);
                offset += 2;
            }
        }
        
        this.resolveIndices.setUint16(offset, 0, true);
        offset += 2;

        this.indices = offset >> 1;
        this.treePtr = this.indicesPtr + offset;
        this.treeBuffer = new DataView(this.memory.buffer, this.treePtr);
    }

    updateCells(dt) {
        this.wasm.update(0, this.indicesPtr, dt,
            this.options.EJECT_MAX_AGE,
            this.options.PLAYER_AUTOSPLIT_SIZE,
            this.options.DECAY_MIN,
            this.options.STATIC_DECAY,
            this.options.DYNAMIC_DECAY,
            -this.options.MAP_HW, this.options.MAP_HW,
            -this.options.MAP_HH, this.options.MAP_HH);
    }

    updatePlayerCells(dt) {
        const initial = Math.round(1000 * this.options.PLAYER_MERGE_TIME);
        
        let ptr = this.indicesPtr + (this.removedCells.length << 1);
        for (const id in this.game.controls) {
            const c = this.game.controls[~~id];
            if (!c.handle) continue;
            const s = this.counters[~~id].size;
            s && this.wasm.update_player_cells(0, ptr, s,
                c.mouseX, c.mouseY, 
                c.lockDir, c.linearEquation[0], c.linearEquation[1], c.linearEquation[2],
                dt,
                initial, this.options.PLAYER_MERGE_INCREASE, this.options.PLAYER_SPEED,
                this.options.PLAYER_MERGE_TIME, this.options.PLAYER_NO_MERGE_DELAY, this.options.PLAYER_MERGE_NEW_VER);
            ptr += s << 1;
        }
    }

    updateTree() {
        // Autosplit and update quadtree
        if (this.options.PLAYER_AUTOSPLIT_SIZE) {
            // starting after removed cells
            for (let i = this.removedCells.length; i < this.indices - 1; i++) {
                const index = this.resolveIndices.getUint16(i * 2, true);
                const cell = this.cells[index];

                if (cell.shouldAuto && cell.age > this.options.PLAYER_AUTOSPLIT_DELAY) {
                    // const cellsLeft = 1 + this.options.PLAYER_MAX_CELLS - this.counters[cell.type].size;
                    // if (cellsLeft <= 0) continue;
                    const splitTimes = Math.ceil(cell.r * cell.r / this.options.PLAYER_AUTOSPLIT_SIZE / this.options.PLAYER_AUTOSPLIT_SIZE);
                    const splitSizes = Math.min(Math.sqrt(cell.r * cell.r / splitTimes), this.options.PLAYER_AUTOSPLIT_SIZE);
                    for (let i = 1; i < splitTimes; i++) {
                        const angle = Math.random() * 2 * Math.PI;
                        this.splitFromCell(cell, splitSizes, Math.sin(angle), Math.cos(angle), this.options.PLAYER_SPLIT_BOOST);
                    }
                    cell.r = splitSizes;
                    cell.updated = true;
                }

                // Update quadtree
                if (cell.type > 250 && !cell.isUpdated) continue;
                this.tree.update(cell);
            }
        } else {
            // Only update quadtree (starting after removed cells)
            for (let i = this.removedCells.length; i < this.indices - 1; i++) {
                const index = this.resolveIndices.getUint16(i * 2, true);
                const cell = this.cells[index];
                // Update quadtree
                if (cell.type > 250 && !cell.isUpdated) continue;
                this.tree.update(cell);
            }
        }
    }

    /**
     * Only set the bit for remove
     * @param {number} id
     * @param {boolean} replace
     */
    kill(id, replace) {
        if (replace) {
            for (const cell_id of this.counters[id]) {
                const cell = this.cells[cell_id];
                const deadCell = this.newCell(cell.x, cell.y, cell.r, DEAD_CELL_TYPE, 
                    cell.boostX, cell.boostY, cell.boost, false); // Don't insert it because we just swap it
                this.tree.swap(cell, deadCell); // Swap it with current cell, no need to update the tree
                this.wasm.clear_cell(0, cell_id); // 0 out memory of this cell because it's not needed anymore
            }
        } else {
            for (const cell_id of this.counters[id]) this.cells[cell_id].remove();
        }
        this.counters[id].clear();
    }

    resolve() {
        const VIRUS_MAX_SIZE = Math.sqrt(this.options.VIRUS_SIZE * this.options.VIRUS_SIZE +
            this.options.EJECT_SIZE * this.options.EJECT_SIZE * this.options.VIRUS_FEED_TIMES);

        // Magic goes here
        this.collisions = this.wasm.resolve(0,
            this.indicesPtr, this.counters[PELLET_TYPE].size,
            this.treePtr, this.stackPtr,
            this.options.PLAYER_NO_MERGE_DELAY, this.options.PLAYER_NO_COLLI_DELAY,
            this.options.EAT_OVERLAP, this.options.EAT_MULT, VIRUS_MAX_SIZE, this.options.PLAYER_DEAD_DELAY);
    }

    postResolve() {
        this.removedCells = [];
        // Handle pop, update quadtree, remove item from quadtree
        for (let i = 0; i < this.indices; i++) {
            const index = this.resolveIndices.getUint16(i * 2, true);
            const cell = this.cells[index];
            if (cell.shouldRemove) {
                this.tree.remove(cell);
                this.counters[cell.type].delete(cell.id);
                this.removedCells.push(index);
                this.cellCount--;
            } else if (cell.popped) {
                // pop the cell OR split virus
                if (cell.type == VIRUS_TYPE) {
                    cell.r = this.options.VIRUS_SIZE;
                    this.tree.update(cell);
                    const angle = Math.atan2(cell.boostX, cell.boostY);
                    this.newCell(cell.x, cell.y, this.options.VIRUS_SIZE, VIRUS_TYPE, 
                        Math.sin(angle), Math.cos(angle), this.options.VIRUS_SPLIT_BOOST);
                } else {
                    this.game.controls[cell.type].lastPoppedTick = this.__now;
                    const splits = this.distributeCellMass(cell);
                    splits.length && (this.game.controls[cell.type].lockDir = false);
                    for (const mass of splits) {
                        const angle = Math.random() * 2 * Math.PI;
                        this.splitFromCell(cell, Math.sqrt(mass * 100),
                            Math.sin(angle), Math.cos(angle), this.options.PLAYER_SPLIT_BOOST);
                    }
                }
            } else if (cell.updated) this.tree.update(cell);
        }
    }

    /**
     * @param {Cell} cell 
     * @param {number} size 
     * @param {number} boostX 
     * @param {number} boostY 
     * @param {number} boost
     */
    splitFromCell(cell, size, boostX, boostY, boost) {
        cell.r = Math.sqrt(cell.r * cell.r - size * size);
        cell.updated = true;
        const x = cell.x + this.options.PLAYER_SPLIT_DIST * boostX;
        const y = cell.y + this.options.PLAYER_SPLIT_DIST * boostY;
        this.newCell(x, y, size, cell.type, boostX, boostY, boost);
    }

    /**
     * @param {Cell} cell
     * @returns {number[]}
     */
    distributeCellMass(cell) {
        let cellsLeft = this.options.PLAYER_MAX_CELLS - this.counters[cell.type].size;
        if (cellsLeft <= 0) return [];
        let splitMin = this.options.PLAYER_MIN_SPLIT_SIZE;
        splitMin = splitMin * splitMin / 100;
        const cellMass = cell.r * cell.r / 100;
        if (this.options.VIRUS_MONOTONE_POP) {
            const amount = Math.min(Math.floor(cellMass / splitMin), cellsLeft);
            const perPiece = cellMass / (amount + 1);
            return new Array(amount).fill(perPiece);
        }
        if (cellMass / cellsLeft < splitMin) {
            let amount = 2, perPiece = NaN;
            while ((perPiece = cellMass / (amount + 1)) >= splitMin && amount * 2 <= cellsLeft)
                amount *= 2;
            return new Array(amount).fill(perPiece);
        }
        const splits = [];
        let nextMass = cellMass / 2;
        let massLeft = cellMass / 2;
        while (cellsLeft > 0) {
            if (nextMass / cellsLeft < splitMin) break;
            while (nextMass >= massLeft && cellsLeft > 1)
                nextMass /= 2;
            splits.push(nextMass);
            massLeft -= nextMass;
            cellsLeft--;
        }
        nextMass = massLeft / cellsLeft;
        return splits.concat(new Array(cellsLeft).fill(nextMass));
    }

    /**
     * @param {number} x 
     * @param {number} y 
     * @param {number} size
     * @param {number} type
     * @return {Cell}
     */
    newCell(x, y, size, type, boostX = 0, boostY = 0, boost = 0, insert = true) {
        
        if (this.cellCount >= this.options.CELL_LIMIT - 1) {
            this.stop();
            return console.log("CAN NOT SPAWN NEW CELL: " + this.cellCount);
        }

        let tries = 0;
        while (this.cells[this.__next_cell_id].exists) {
            this.__next_cell_id = ((this.__next_cell_id + 1) % this.options.CELL_LIMIT) || 1;
            tries++;
            if (tries >= 65536) {
                console.log("CAN NOT SPAWN NEW CELL: " + this.cellCount);
                process.exit(1);
            }
        }

        const cell = this.cells[this.__next_cell_id];
        cell.x = x;
        cell.y = y;
        cell.r = size;
        cell.type = type;
        cell.boostX = boostX;
        cell.boostY = boostY;
        cell.boost = boost;
        cell.resetFlag();
        
        if (insert) {
            this.tree.insert(cell);
            this.cellCount++;
        }

        this.counters[cell.type].add(cell.id);
        return cell;
    }

    /** @param {number} size */
    randomPoint(size, xmin = -this.options.MAP_HW, xmax = this.options.MAP_HW,
        ymin = -this.options.MAP_HH, ymax = this.options.MAP_HH) {

        xmin = clamp(xmin, -this.options.MAP_HW + size, this.options.MAP_HW - size);
        xmax = clamp(xmax, -this.options.MAP_HW + size, this.options.MAP_HW - size);

        ymin = clamp(ymin, -this.options.MAP_HH + size, this.options.MAP_HH - size);
        ymax = clamp(ymax, -this.options.MAP_HH + size, this.options.MAP_HH - size);

        return [range(xmin, xmax), range(ymin, ymax)];
    }

    getPlayerSpawnPoint() {
        if (this.alivePlayers.length) {
            const s = this.options.PLAYER_SPAWN_SIZE;
            const safeRadius = s * this.options.SAFE_SPAWN_RADIUS;

            const target = pick(this.alivePlayers);

            const xmin = target.box.l - this.options.PLAYER_VIEW_MIN;
            const xmax = target.box.r + this.options.PLAYER_VIEW_MIN;
            const ymin = target.box.b - this.options.PLAYER_VIEW_MIN;
            const ymax = target.box.t + this.options.PLAYER_VIEW_MIN;
            
            let tries = this.options.SAFE_SPAWN_TRIES;
            while (--tries) {
                const point = this.randomPoint(s, xmin, xmax, ymin, ymax);
                if (this.wasm.is_safe(0, point[0], point[1], safeRadius,
                    this.treePtr, this.stackPtr) > 0)
                    return point;
            }
        }

        return this.getSafeSpawnPoint(this.options.PLAYER_SPAWN_SIZE);
    }

    /** @param {number} size */
    getSafeSpawnPoint(size) {
        if (!this.treePtr) return this.randomPoint(size);

        let tries = this.options.SAFE_SPAWN_TRIES;
        while (--tries) {
            const point = this.randomPoint(size);
            if (this.wasm.is_safe(0, point[0], point[1],
                size * this.options.SAFE_SPAWN_RADIUS,
                this.treePtr, this.stackPtr) > 0)
                return point;
        }
        return this.randomPoint(size);
    }

    // Sort all the cell indices according to their size (to make solotrick work)
    sortIndices() {

        let offset = 0;
        for (let type = 0; type < this.counters.length; type++) {
            const iter = this.counters[type];
            for (const cell_id of iter) {
                this.resolveIndices.setUint16(offset, cell_id, true);
                offset += 2;
            }
        }
        
        this.resolveIndices.setUint16(offset, 0, true);
        offset += 2;

        this.indices = offset >> 1;

        let ptr = this.indicesPtr;
        for (let type = 0; type <= 250; type++) {
            const s = this.counters[type].size;
            s && this.wasm.sort_indices(0, ptr, s);
            ptr += s << 1;
        }

        this.treePtr = this.indicesPtr + offset;
        this.treeBuffer = new DataView(this.memory.buffer, this.treePtr);
    }

    serialize() {
        this.stackPtr = this.tree.serialize(this.treeBuffer) + this.treePtr;
    }

    /** @param {Controller} controller */
    query(controller) {
        // 4 = pointer size, second 4 is because 4 nodes per level so we need to reserve enough space for the stack
        let listPtr = this.stackPtr + 4 * 4 * this.options.QUADTREE_MAX_LEVEL;
        listPtr % 2 && listPtr++; // Multiple of 2

        const length = this.wasm.select(0, this.treePtr, 
            this.stackPtr, listPtr,
            controller.viewportX - controller.viewportHW, controller.viewportX + controller.viewportHW,
            controller.viewportY - controller.viewportHH, controller.viewportY + controller.viewportHH);
        
        return new Uint16Array(this.memory.buffer, listPtr, length);
    }
}

module.exports.DefaultSettings = DefaultSettings;