import Foundation

enum NativeCloseContract {
    // Installed before the editor so input cannot outrun the native quit handshake.
    static let installScript = """
    (() => {
        let composing = false, pendingInput = false, epoch = 0;
        let acceptedEpoch = null, acceptedHook = null, canonicalEpoch = 0, acceptedCanonicalEpoch = null, acceptedReason = null;
        const invalidate = () => { epoch++; acceptedEpoch = null; acceptedHook = null; };
        const settleInput = () => {
            pendingInput = true;
            const inputEpoch = epoch;
            window.setTimeout(() => { if (epoch === inputEpoch) pendingInput = false; }, 0);
        };
        window.addEventListener('compositionstart', () => { composing = true; invalidate(); }, true);
        window.addEventListener('compositionend', () => { composing = false; invalidate(); settleInput(); }, true);
        window.addEventListener('beforeinput', event => {
            invalidate(); if (event.isComposing) composing = true; settleInput();
        }, true);
        window.addEventListener('input', event => {
            invalidate(); if (event.isComposing) composing = true; settleInput();
        }, true);
        window.addEventListener('mori-document-change', () => {
            canonicalEpoch++; acceptedEpoch = null; acceptedCanonicalEpoch = null; acceptedHook = null;
        }, true);
        window.__moriNativeClose = Object.freeze({
            prepare: async (reason = 'window') => {
                acceptedEpoch = null; acceptedHook = null;
                const hook = window.__moriBeforeClose, inputEpoch = epoch;
                if (composing || pendingInput || typeof hook !== 'function') return false;
                if (reason !== 'quit' && reason !== 'window') return false;
                const accepted = await hook(reason);
                if (accepted !== true || composing || pendingInput || epoch !== inputEpoch || window.__moriBeforeClose !== hook) return false;
                acceptedEpoch = epoch; acceptedCanonicalEpoch = canonicalEpoch; acceptedHook = hook; acceptedReason = reason;
                return true;
            },
            isCurrent: (reason = acceptedReason) => reason === acceptedReason && acceptedEpoch !== null && acceptedEpoch === epoch && acceptedCanonicalEpoch === canonicalEpoch && !composing && !pendingInput && window.__moriBeforeClose === acceptedHook
        });
    })();
    """
    static let prepareScript = "return typeof window.__moriNativeClose?.prepare === 'function' ? await window.__moriNativeClose.prepare() : false"
    static let quitPrepareScript = "return typeof window.__moriNativeClose?.prepare === 'function' ? await window.__moriNativeClose.prepare('quit') : false"
    static let windowValidationScript = "return window.__moriNativeClose?.isCurrent('window') === true"
    static let quitValidationScript = "return window.__moriNativeClose?.isCurrent('quit') === true"
    static let validationScript = "return window.__moriNativeClose?.isCurrent() === true"
}
