import { dom } from "./dom.js";
import { state } from "./state.js";
import { clearCart } from "./till.js";

export function showApplication(username) {
    dom.loginScreen.hidden = true;
    dom.appScreen.hidden = false;
    dom.loggedInUser.textContent = username;

    document.dispatchEvent(new CustomEvent("user-role-changed"));
}

export function showLogin() {
    dom.appScreen.hidden = true;
    dom.loginScreen.hidden = false;
    dom.loginForm.reset();
    dom.errorMessage.textContent = "";
}

export function validateSavedSession() {
    const savedUsername = sessionStorage.getItem("merchTillUsername");

    if (!savedUsername) {
        return;
    }

    const user = state.users.find(function (item) {
        return item.username === savedUsername && item.active;
    });

    if (!user) {
        sessionStorage.clear();
        showLogin();
        return;
    }

    sessionStorage.setItem("merchTillRole", user.role);
    showApplication(user.username);
}

export function initialiseAuthentication() {
    dom.loginForm.addEventListener("submit", function (event) {
        event.preventDefault();

        const enteredUsername =
            document.getElementById("username").value.trim();
        const enteredPassword =
            document.getElementById("password").value;

        const matchingUser = state.users.find(function (user) {
            return (
                user.active &&
                user.username === enteredUsername &&
                user.password === enteredPassword
            );
        });

        if (matchingUser) {
            sessionStorage.setItem("merchTillLoggedIn", "true");
            sessionStorage.setItem("merchTillUsername", matchingUser.username);
            sessionStorage.setItem("merchTillRole", matchingUser.role);
            showApplication(matchingUser.username);
            return;
        }

        dom.errorMessage.textContent = "Incorrect username or password.";
        document.getElementById("password").value = "";
    });

    dom.logoutButton.addEventListener("click", function () {
        sessionStorage.clear();
        clearCart();
        showLogin();
        document.dispatchEvent(new CustomEvent("user-role-changed"));
    });

    const savedLogin = sessionStorage.getItem("merchTillLoggedIn");
    const savedUsername = sessionStorage.getItem("merchTillUsername");

    if (savedLogin === "true" && savedUsername) {
        dom.loginScreen.hidden = true;
        dom.appScreen.hidden = false;
        dom.loggedInUser.textContent = savedUsername;
    } else {
        showLogin();
    }
}
