import { dom } from "./dom.js";
import { canAccessScreen } from "./permissions.js";


function showScreen(screenId) {
    if (!canAccessScreen(screenId)) {
        screenId = "till-section";
    }

    dom.appSections.forEach(function (section) {
        section.hidden = section.id !== screenId;
    });

    dom.navigationButtons.forEach(function (button) {
        const buttonScreen =
            button.dataset.screen;

        button.classList.toggle(
            "active",
            buttonScreen === screenId
        );
    });
}


export function applyNavigationPermissions() {
    dom.navigationButtons.forEach(function (button) {
        const screenId =
            button.dataset.screen;

        button.hidden =
            !canAccessScreen(screenId);
    });

    const visibleSection =
        Array.from(dom.appSections).find(function (section) {
            return !section.hidden;
        });

    if (
        !visibleSection ||
        !canAccessScreen(visibleSection.id)
    ) {
        showScreen("till-section");
    }
}


export function initialiseNavigation() {
    dom.navigationButtons.forEach(function (button) {
        button.addEventListener("click", function () {
            const selectedScreen =
                button.dataset.screen;

            if (!canAccessScreen(selectedScreen)) {
                showScreen("till-section");
                return;
            }

            showScreen(selectedScreen);
        });
    });

    applyNavigationPermissions();
}
