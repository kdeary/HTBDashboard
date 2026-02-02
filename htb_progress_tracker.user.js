// ==UserScript==
// @name         HTB Progress Tracker & Sender
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Scrapes HTB progress and sends it to a dashboard via PeerJS. Configurable Host ID.
// @author       You
// @match        https://app.hackthebox.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hackthebox.com
// @grant        none
// @require      https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration & State ---
    const STORAGE_KEY = 'htb_tracker_host_id';
    const DEFAULT_HOST_ID = 'htb-dashboard-listener-12345';

    let HOST_PEER_ID = localStorage.getItem(STORAGE_KEY) || DEFAULT_HOST_ID;

    const CONFIG = {
        UPDATE_INTERVAL_MS: 3000,
        DEBUG: true
    };

    let peer = null;
    let conn = null;
    let lastReportHash = '';
    let connectionTimeout = null;

    // --- UI Injection ---
    function injectSettingsUI() {
        if (document.getElementById('htb-tracker-settings-btn')) return;

        const container = document.createElement('div');
        container.id = 'htb-tracker-ui';
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            font-family: monospace;
        `;

        const btn = document.createElement('button');
        btn.id = 'htb-tracker-settings-btn';
        btn.innerText = '⚙️ Tracker';
        btn.style.cssText = `
            background: #1a202c;
            color: #9fef00;
            border: 1px solid #9fef00;
            padding: 8px 12px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
            transition: all 0.2s;
        `;

        btn.onmouseover = () => btn.style.transform = 'scale(1.05)';
        btn.onmouseout = () => btn.style.transform = 'scale(1)';
        btn.onclick = showSettingsModal;

        container.appendChild(btn);
        document.body.appendChild(container);
    }

    function showSettingsModal() {
        const currentId = localStorage.getItem(STORAGE_KEY) || DEFAULT_HOST_ID;

        // Simple prompt for now, can be upgraded to a modal logic if needed
        const newId = prompt('Enter Dashboard Host ID:', currentId);

        if (newId !== null && newId.trim() !== '') {
            if (newId.trim() !== currentId) {
                localStorage.setItem(STORAGE_KEY, newId.trim());
                HOST_PEER_ID = newId.trim();
                alert('Host ID saved! Reloading connection...');
                // Re-init connection
                if (peer) {
                    peer.destroy();
                    peer = null;
                    conn = null;
                }
                initPeer();
            }
        }
    }

    // --- PeerJS Logic ---

    function initPeer() {
        // If peer already exists and is alive, don't recreate
        if (peer && !peer.destroyed) return;

        const myId = 'htb-user-' + Math.floor(Math.random() * 100000);
        log(`Initializing PeerJS with ID: ${myId}`);

        peer = new Peer(myId, { debug: 1 });

        peer.on('open', (id) => {
            log(`PeerJS signaling connected. ID: ${id}`);
            connectToHost();
        });

        // The signaling connection to the PeerJS server was lost
        peer.on('disconnected', () => {
            log('Peer disconnected from signaling server. Attempting reconnect...');
            peer.reconnect();
        });

        // The peer object was destroyed (fatal)
        peer.on('close', () => {
            log('Peer object destroyed. Re-initializing in 2s...');
            peer = null;
            conn = null;
            setTimeout(initPeer, 2000);
        });

        peer.on('error', (err) => {
            log(`PeerJS Error: ${err.type}`);
            // For fatal errors, destroy and restart
            if (['browser-incompatible', 'invalid-id', 'unavailable-id', 'ssl-unavailable', 'network', 'webrtc'].includes(err.type)) {
                log('Fatal error detected. Restarting peer service in 5s...');
                if (peer) peer.destroy(); // Ensure it's dead
                setTimeout(initPeer, 5000);
            }
        });
    }

    function connectToHost() {
        // 1. Peer Health Checks
        if (!peer) {
            initPeer();
            return;
        }
        if (peer.destroyed) {
            initPeer();
            return;
        }
        if (peer.disconnected) {
            log('Peer disconnected. Reconnecting to signaling server...');
            peer.reconnect();
            return;
        }

        // 2. Connection Health Checks
        if (conn) {
            if (conn.open) return; // Already good
            log('Closing existing non-open connection...');
            conn.close(); // Clean up stale connection
        }

        log(`Initiating connection to host: ${HOST_PEER_ID}`);
        conn = peer.connect(HOST_PEER_ID, {
            reliable: true
        });

        // 3. Connection Timeout Guard
        if (connectionTimeout) clearTimeout(connectionTimeout);
        connectionTimeout = setTimeout(() => {
            if (conn && !conn.open) {
                log('Connection attempt timed out. Resetting...');
                conn.close();
                conn = null;
            }
        }, 5000);

        conn.on('open', () => {
            log('Connected to Dashboard Host!');
            if (connectionTimeout) clearTimeout(connectionTimeout);

            // CRITICAL FIX: Reset the report hash on new connection.
            lastReportHash = '';

            scrapeAndSend();
        });

        conn.on('close', () => {
            log('Connection to host closed.');
            conn = null;
        });

        conn.on('error', (err) => {
            log('Connection error: ' + err);
            conn = null;
        });
    }

    function log(msg) {
        if (CONFIG.DEBUG) console.log(`[HTB Tracker] ${msg}`);
    }

    // --- Scraper Logic ---

    function getProgressData() {
        // Try multiple selectors for username to be robust
        let username = 'Anonymous';
        const userElVals = [
            document.querySelector('.htb-tooltip-container.htb-menu--non-focusable-trigger .htb-body-md.htb-font-medium.htb-text-primary'),
            document.querySelector('[data-testid="navbar-user-menu"] span')
        ];

        for (const el of userElVals) {
            if (el) { username = el.innerText.trim(); break; }
        }

        const machineEl = document.querySelector('.htb-text-primary.htb-font-medium.avatar-icon-name-details__name.htb-heading-lg.htb-font-bold');
        const machineName = machineEl ? machineEl.innerText.trim() : 'Unknown Machine';

        const taskListContainer = document.querySelector('.flag-submission-list');
        if (!taskListContainer) return null;

        const totalTasksAttr = taskListContainer.getAttribute('data-total-items-value');
        let totalTasks = totalTasksAttr ? parseInt(totalTasksAttr) : 0;

        const listItems = taskListContainer.querySelectorAll('li');
        if (totalTasks === 0) totalTasks = listItems.length;

        let completedTasks = 0;
        const solvedTaskNames = [];

        listItems.forEach((li, index) => {
            const icon = li.querySelector('svg');
            const nameEl = li.querySelector('.flag-submission-list-item__header span');
            const taskName = nameEl ? nameEl.innerText.trim() : `Task ${index + 1}`;

            let isSolved = false;
            const input = li.querySelector('input');

            if (input && input.value && input.disabled) isSolved = true;
            if (!isSolved && icon) {
                const style = window.getComputedStyle(icon);
                const color = style.color || style.fill;
                if (color.includes('178, 242, 51') || color.includes('#b2f233')) isSolved = true;
            }
            if (li.classList.contains('is-solved') || li.innerHTML.includes('text-success')) isSolved = true;

            if (isSolved) {
                completedTasks++;
                solvedTaskNames.push(taskName);
            }
        });

        const remainingTasks = totalTasks - completedTasks;

        return {
            username: username,
            machine: machineName,
            progress: {
                total: totalTasks,
                completed: completedTasks,
                remaining: remainingTasks,
                percentage: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
                solvedTaskNames: solvedTaskNames
            },
            timestamp: Date.now()
        };
    }

    function scrapeAndSend() {
        // Always try to inject UI if missing
        injectSettingsUI();

        if (!conn || !conn.open) {
            connectToHost();
            return;
        }

        const data = getProgressData();

        if (data) {
            const currentHash = JSON.stringify({
                p: data.progress.percentage,
                c: data.progress.completed,
                m: data.machine
            });

            if (currentHash !== lastReportHash) {
                log('Sending FULL UPDATE (Data Changed or New Connection)...');
                conn.send({ type: 'UPDATE', payload: data });
                lastReportHash = currentHash;
            } else {
                conn.send({ type: 'HEARTBEAT', payload: { username: data.username } });
            }
        }
    }

    // --- Init ---
    // Delay init slightly to ensure DOM is ready
    setTimeout(() => {
        injectSettingsUI();
        initPeer();

        const observer = new MutationObserver(() => scrapeAndSend());
        observer.observe(document.body, { childList: true, subtree: true });

        // Main loop
        setInterval(scrapeAndSend, CONFIG.UPDATE_INTERVAL_MS);
    }, 1000);

})();