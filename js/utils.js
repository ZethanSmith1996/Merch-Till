export function escapeHTML(value) {
    const temporaryElement = document.createElement("div");
    temporaryElement.textContent = value;
    return temporaryElement.innerHTML;
}

export function announceProductsChanged() {
    document.dispatchEvent(new CustomEvent("products-changed"));
}
