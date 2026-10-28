// auth.js: sign in, create account, sign out, login screen.
import { auth } from './firebase.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, setPersistence, browserLocalPersistence, browserSessionPersistence, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { h, formModal } from './ui.js';

export const onUser = cb => onAuthStateChanged(auth, cb);
export const logout = () => signOut(auth);

const RESET_SENT = 'If that account exists, a reset email has been sent.';

const MSG = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'No account with that email.',
  'auth/invalid-email': 'That email address does not look right.',
  'auth/missing-email': 'Enter your email address first.',
  'auth/email-already-in-use': 'An account with that email already exists. Try signing in.',
  'auth/weak-password': 'Password is too short. Use at least 6 characters.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/unauthorized-domain': 'This site address is not authorised in Firebase (Authentication > Settings > Authorized domains).',
  'auth/operation-not-allowed': 'Email/password sign-in is not switched on in the Firebase console.',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'The firebaseConfig in firebase.js is not filled in correctly.'
};

export function renderLogin(root) {
  let creating = false;
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'email', required: true });
  const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const stay = h('input', { type: 'checkbox', checked: true });
  const err = h('p', { class: 'err', hidden: true });
  const info = h('p', { class: 'ok', hidden: true });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const sw = h('button', { class: 'link', type: 'button' }, 'Create account');
  const forgot = h('button', { class: 'link', type: 'button' }, 'Forgot password?');

  // Asks for the email (pre-filled from the login field) and sends the reset link. The answer is the same whether or not the
  // account exists, so this cannot be used to find out which emails have accounts.
  forgot.onclick = async () => {
    err.hidden = true; info.hidden = true;
    const r = await formModal({
      title: 'Reset password', okText: 'Send reset email',
      hint: 'Enter your account email and we will send you a link to choose a new password.',
      fields: [{ name: 'email', label: 'Email', value: email.value.trim(), placeholder: 'you@example.com' }]
    });
    if (!r) return;
    forgot.disabled = true;
    try {
      await sendPasswordResetEmail(auth, r.email.trim());
      email.value = r.email.trim();
      info.textContent = RESET_SENT; info.hidden = false;
    } catch (ex) {
      if (ex.code === 'auth/user-not-found') { info.textContent = RESET_SENT; info.hidden = false; }
      else { err.textContent = MSG[ex.code] || 'Could not send the reset email: ' + (ex.code || ex.message); err.hidden = false; }
    } finally { forgot.disabled = false; }
  };

  sw.onclick = () => {
    creating = !creating;
    go.textContent = creating ? 'Create account' : 'Sign in';
    sw.textContent = creating ? 'I already have an account' : 'Create account';
    pass.autocomplete = creating ? 'new-password' : 'current-password';
    err.hidden = true; info.hidden = true;
    forgot.hidden = creating; // a reset only makes sense for an existing account
  };

  const form = h('form', {
    class: 'login-card',
    onsubmit: async e => {
      e.preventDefault();
      go.disabled = true; err.hidden = true; info.hidden = true;
      try {
        await setPersistence(auth, stay.checked ? browserLocalPersistence : browserSessionPersistence);
        if (creating) await createUserWithEmailAndPassword(auth, email.value.trim(), pass.value);
        else await signInWithEmailAndPassword(auth, email.value.trim(), pass.value);
      } catch (ex) {
        err.textContent = MSG[ex.code] || 'Sign-in failed: ' + (ex.code || ex.message);
        err.hidden = false;
      } finally { go.disabled = false; }
    }
  },
    h('h1', {}, 'Study'),
    email, pass,
    h('label', { class: 'check' }, stay, 'Stay logged in'),
    err, info, go, forgot, sw);

  root.replaceChildren(h('div', { class: 'login-wrap' }, form));
}
