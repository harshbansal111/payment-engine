// src/engine/stateMachine.js
// Defines and enforces valid state transitions.

const VALID_TRANSITIONS = {
    'INIT':       ['PROCESSING'],
    'PROCESSING': ['SUCCESS', 'FAILED'],
    'SUCCESS':    [],   // terminal
    'FAILED':     [],   // terminal
};

function assertValidTransition(currentStatus, nextStatus) {
    const allowed = VALID_TRANSITIONS[currentStatus];

    if (!allowed) {
        throw new Error(`Unknown status: "${currentStatus}"`);
    }

    if (!allowed.includes(nextStatus)) {
        throw new Error(
            `Invalid transition: ${currentStatus} → ${nextStatus}. ` +
            `Allowed from ${currentStatus}: [${allowed.join(', ') || 'none — terminal state'}]`
        );
    }
}

function isTerminal(status) {
    return VALID_TRANSITIONS[status]?.length === 0;
}

module.exports = { assertValidTransition, isTerminal, VALID_TRANSITIONS };
