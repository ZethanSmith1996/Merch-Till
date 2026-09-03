import { currencyFormatter, discountAuthorisers } from "./config.js";
import { dom } from "./dom.js";

import {
    loadProductsFromDatabase,
    saveCompletedSaleTransaction
} from "./database.js";

import { state } from "./state.js";

import {
    announceProductsChanged,
    escapeHTML
} from "./utils.js";

import { createSaleRecord } from "./sales.js";
import { isTrainingUser } from "./permissions.js";

function isVariantProduct(product) {
    return Boolean(product.groupId && product.variantName);
}

function getProductTileColor(product) {
    const allowedColours = new Set([
        "pink",
        "blue",
        "green",
        "yellow"
    ]);

    return allowedColours.has(product.tileColor)
        ? product.tileColor
        : "default";
}

function applyProductTileColor(button, product) {
    const tileColor = getProductTileColor(product);

    if (tileColor !== "default") {
        button.classList.add(`product-color-${tileColor}`);
    }
}

function productsInGroup(groupId) {
    return state.products
        .filter(function (product) {
            return product.groupId === groupId;
        })
        .sort(function (first, second) {
            return (first.variantOrder ?? 0) - (second.variantOrder ?? 0);
        });
}

function tillDisplayProducts() {
    const rows = [];
    const seenGroups = new Set();

    state.products.forEach(function (product) {
        if (!isVariantProduct(product)) {
            rows.push({
                type: "single",
                product: product
            });
            return;
        }

        if (seenGroups.has(product.groupId)) {
            return;
        }

        seenGroups.add(product.groupId);
        rows.push({
            type: "group",
            groupId: product.groupId,
            products: productsInGroup(product.groupId)
        });
    });

    return rows;
}

/* ==================================================
   Till product buttons
================================================== */

export function renderTillProducts() {
    dom.productGrid.innerHTML = "";

    const trainingMode = isTrainingUser();
    const tradingClosed = !state.currentSession && !trainingMode;
    const displayProducts = tillDisplayProducts();

    if (displayProducts.length === 0) {
        const emptyMessage = document.createElement("div");
        emptyMessage.className = "no-products-message";
        emptyMessage.textContent = "No products available to sell.";
        dom.productGrid.appendChild(emptyMessage);
        return;
    }

    displayProducts.forEach(function (entry) {
        if (entry.type === "single") {
            renderSingleProductButton(entry.product, trainingMode, tradingClosed);
        } else {
            renderVariantGroupButton(entry.products, trainingMode, tradingClosed);
        }
    });
}

function renderSingleProductButton(product, trainingMode, tradingClosed) {
    const productButton = document.createElement("button");
    productButton.type = "button";
    productButton.className = "product-button";
    applyProductTileColor(productButton, product);

    const isSoldOut = product.stock <= 0;

    if ((!trainingMode && isSoldOut) || tradingClosed) {
        productButton.disabled = true;

        if (isSoldOut) {
            productButton.classList.add("sold-out");
        }

        if (tradingClosed) {
            productButton.classList.add("trading-closed");
        }
    }

    let stockText;

    if (trainingMode) {
        stockText = "Training item";
    } else if (isSoldOut) {
        stockText = "Sold Out";
    } else {
        stockText = `${product.stock} in stock`;
    }

    productButton.innerHTML = `
        <span class="product-name">
            ${escapeHTML(product.name)}
        </span>

        <span class="product-price">
            ${currencyFormatter.format(product.price)}
        </span>

        <span class="product-stock">
            ${stockText}
        </span>
    `;

    productButton.addEventListener("click", function () {
        addProductToCart(product.id);
    });

    dom.productGrid.appendChild(productButton);
}

function renderVariantGroupButton(groupProducts, trainingMode, tradingClosed) {
    if (groupProducts.length === 0) {
        return;
    }

    const firstProduct = groupProducts[0];
    const totalStock = groupProducts.reduce(function (sum, product) {
        return sum + product.stock;
    }, 0);
    const isSoldOut = totalStock <= 0;

    const productButton = document.createElement("button");
    productButton.type = "button";
    productButton.className = "product-button variant-product-button";
    applyProductTileColor(productButton, firstProduct);

    if ((!trainingMode && isSoldOut) || tradingClosed) {
        productButton.disabled = true;

        if (isSoldOut) {
            productButton.classList.add("sold-out");
        }

        if (tradingClosed) {
            productButton.classList.add("trading-closed");
        }
    }

    let stockText;

    if (trainingMode) {
        stockText = `${groupProducts.length} variants · Training`;
    } else if (isSoldOut) {
        stockText = "Sold Out";
    } else {
        stockText = `${totalStock} in stock · Choose variant`;
    }

    productButton.innerHTML = `
        <span class="product-name">
            ${escapeHTML(firstProduct.name)}
        </span>

        <span class="product-price">
            ${currencyFormatter.format(firstProduct.price)}
        </span>

        <span class="product-stock">
            ${stockText}
        </span>
    `;

    productButton.addEventListener("click", function () {
        openVariantSelector(firstProduct.groupId);
    });

    dom.productGrid.appendChild(productButton);
}

/* ==================================================
   Variant selector
================================================== */

function openVariantSelector(groupId) {
    const groupProducts = productsInGroup(groupId);

    if (groupProducts.length === 0) {
        return;
    }

    const firstProduct = groupProducts[0];
    const trainingMode = isTrainingUser();

    dom.variantModalTitle.textContent = firstProduct.name;
    dom.variantModalPrice.textContent = `${currencyFormatter.format(firstProduct.price)} · Choose a variant`;
    dom.variantOptions.innerHTML = "";

    groupProducts.forEach(function (product) {
        const optionButton = document.createElement("button");
        optionButton.type = "button";
        optionButton.className = "variant-option-button";

        const soldOut = product.stock <= 0;

        if (!trainingMode && soldOut) {
            optionButton.disabled = true;
            optionButton.classList.add("sold-out");
        }

        const stockText = trainingMode
            ? "Training"
            : soldOut
              ? "Sold Out"
              : `${product.stock} available`;

        optionButton.innerHTML = `
            <strong>${escapeHTML(product.variantName)}</strong>
            <span>${stockText}</span>
        `;

        optionButton.addEventListener("click", function () {
            addProductToCart(product.id);
            closeVariantSelector();
        });

        dom.variantOptions.appendChild(optionButton);
    });

    dom.variantModal.hidden = false;
}

function closeVariantSelector() {
    dom.variantModal.hidden = true;
    dom.variantOptions.innerHTML = "";
}

/* ==================================================
   Add product to basket
================================================== */

function addProductToCart(productId) {
    const trainingMode = isTrainingUser();

    if (!state.currentSession && !trainingMode) {
        window.alert(
            "A trading session is required before you can begin trading."
        );
        return;
    }

    const product = state.products.find(function (item) {
        return item.id === productId;
    });

    if (!product) {
        return;
    }

    if (!trainingMode && product.stock <= 0) {
        return;
    }

    const currentCartQuantity = state.cart.has(productId)
        ? state.cart.get(productId).quantity
        : 0;

    if (!trainingMode && currentCartQuantity >= product.stock) {
        const itemName = product.variantName
            ? `${product.name} — ${product.variantName}`
            : product.name;

        window.alert(
            `There are only ${product.stock} ${itemName} item(s) available.`
        );
        return;
    }

    if (state.cart.has(productId)) {
        state.cart.get(productId).quantity += 1;
    } else {
        state.cart.set(productId, {
            id: product.id,
            name: product.name,
            displayName: product.variantName
                ? `${product.name} — ${product.variantName}`
                : product.name,
            variantName: product.variantName || null,
            groupId: product.groupId || null,
            price: product.price,
            quantity: 1
        });
    }

    renderCart();
}

/* ==================================================
   Basket quantity controls
================================================== */

function increaseQuantity(productId) {
    const cartItem = state.cart.get(productId);
    const product = state.products.find(function (item) {
        return item.id === productId;
    });

    if (!cartItem || !product) {
        return;
    }

    if (!isTrainingUser() && cartItem.quantity >= product.stock) {
        const itemName = product.variantName
            ? `${product.name} — ${product.variantName}`
            : product.name;

        window.alert(
            `There are only ${product.stock} ${itemName} item(s) available.`
        );
        return;
    }

    cartItem.quantity += 1;
    renderCart();
}

function decreaseQuantity(productId) {
    const cartItem = state.cart.get(productId);

    if (!cartItem) {
        return;
    }

    if (cartItem.quantity > 1) {
        cartItem.quantity -= 1;
    } else {
        state.cart.delete(productId);
    }

    renderCart();
}

/* ==================================================
   Basket totals
================================================== */

function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function calculateOrderTotals() {
    let subtotal = 0;

    state.cart.forEach(function (item) {
        subtotal += item.price * item.quantity;
    });

    subtotal = roundMoney(subtotal);

    const discountPercent = Number(state.currentDiscountPercent) || 0;
    const discountAmount = roundMoney(subtotal * (discountPercent / 100));
    const total = roundMoney(Math.max(0, subtotal - discountAmount));

    return {
        subtotal,
        discountPercent,
        discountAmount,
        total
    };
}

function clearCurrentDiscount() {
    state.currentDiscountPercent = 0;
    state.currentDiscountAuthorizedBy = null;
}

function openDiscountModal() {
    if (state.cart.size === 0) {
        return;
    }

    dom.discountFormError.textContent = "";
    dom.discountPercentInput.value = state.currentDiscountPercent > 0
        ? String(state.currentDiscountPercent)
        : "";
    dom.discountPinInput.value = "";
    dom.removeDiscountButton.hidden = state.currentDiscountPercent <= 0;
    dom.discountModal.hidden = false;
    dom.discountPercentInput.focus();
}

function closeDiscountModal() {
    dom.discountModal.hidden = true;
    dom.discountForm.reset();
    dom.discountFormError.textContent = "";
}

function findDiscountAuthoriser(pin) {
    return discountAuthorisers.find(function (authoriser) {
        return authoriser.pin === pin;
    }) || null;
}

function applyDiscount(event) {
    event.preventDefault();

    if (state.cart.size === 0) {
        closeDiscountModal();
        return;
    }

    const percentage = Number(dom.discountPercentInput.value);
    const pin = dom.discountPinInput.value.trim();

    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
        dom.discountFormError.textContent =
            "Enter a discount percentage greater than 0 and no more than 100.";
        return;
    }

    const authoriser = findDiscountAuthoriser(pin);

    if (!authoriser) {
        dom.discountFormError.textContent =
            "The Admin PIN is incorrect.";
        dom.discountPinInput.select();
        return;
    }

    state.currentDiscountPercent = percentage;
    state.currentDiscountAuthorizedBy = authoriser.username;
    closeDiscountModal();
    renderCart();
}

function removeDiscount() {
    clearCurrentDiscount();
    closeDiscountModal();
    renderCart();
}

/* ==================================================
   Render current basket
================================================== */

export function renderCart() {
    dom.orderItemsContainer.innerHTML = "";

    const hasItems = state.cart.size > 0;
    const trainingMode = isTrainingUser();

    dom.emptyOrderMessage.hidden = hasItems;
    dom.orderItemsContainer.hidden = !hasItems;
    dom.clearOrderButton.disabled = !hasItems;
    dom.orderOptionsButton.disabled = !hasItems;
    dom.completeSaleButton.disabled =
        !hasItems || (!state.currentSession && !trainingMode);

    state.cart.forEach(function (item) {
        const orderItem = document.createElement("div");
        orderItem.className = "order-item";

        const lineTotal = item.price * item.quantity;
        const displayName = item.displayName || item.name;

        orderItem.innerHTML = `
            <div class="order-item-details">
                <div class="order-item-name">
                    ${escapeHTML(displayName)}
                </div>

                <div class="order-item-price">
                    ${currencyFormatter.format(item.price)} each
                </div>
            </div>

            <div class="order-item-controls">
                <button
                    type="button"
                    class="quantity-button decrease-button"
                    aria-label="Decrease ${escapeHTML(displayName)} quantity"
                >
                    −
                </button>

                <span class="item-quantity">
                    ${item.quantity}
                </span>

                <button
                    type="button"
                    class="quantity-button increase-button"
                    aria-label="Increase ${escapeHTML(displayName)} quantity"
                >
                    +
                </button>

                <span class="item-total">
                    ${currencyFormatter.format(lineTotal)}
                </span>
            </div>
        `;

        orderItem
            .querySelector(".decrease-button")
            .addEventListener("click", function () {
                decreaseQuantity(item.id);
            });

        orderItem
            .querySelector(".increase-button")
            .addEventListener("click", function () {
                increaseQuantity(item.id);
            });

        dom.orderItemsContainer.appendChild(orderItem);
    });

    if (!hasItems && state.currentDiscountPercent > 0) {
        clearCurrentDiscount();
    }

    const totals = calculateOrderTotals();
    const hasDiscount = totals.discountPercent > 0;

    dom.orderSubtotalRow.hidden = !hasDiscount;
    dom.orderDiscountRow.hidden = !hasDiscount;
    dom.orderSubtotal.textContent = currencyFormatter.format(totals.subtotal);
    dom.orderDiscountLabel.textContent = hasDiscount
        ? `Discount (${totals.discountPercent}%)`
        : "Discount";
    dom.orderDiscount.textContent = `-${currencyFormatter.format(totals.discountAmount)}`;
    dom.orderTotal.textContent = currencyFormatter.format(totals.total);
}

/* ==================================================
   Clear basket
================================================== */

export function clearCart() {
    state.cart.clear();
    clearCurrentDiscount();
    renderCart();
}

/* ==================================================
   Complete sale
================================================== */

async function completeSale() {
    const trainingMode = isTrainingUser();

    if (!state.currentSession && !trainingMode) {
        window.alert(
            "A trading session is required before a sale can be completed."
        );
        return;
    }

    if (state.cart.size === 0) {
        return;
    }

    const totals = calculateOrderTotals();
    const saleTotal = totals.total;

    if (trainingMode) {
        window.alert(
            "Training sale completed.\n\n" +
            `Total: ${currencyFormatter.format(saleTotal)}\n` +
            (totals.discountAmount > 0
                ? `Discount: -${currencyFormatter.format(totals.discountAmount)}\n\n`
                : "\n") +
            "No stock has been changed.\n" +
            "No transaction has been recorded."
        );

        state.currentOrderNumber += 1;
        dom.orderNumberDisplay.textContent = state.currentOrderNumber;
        state.cart.clear();
        clearCurrentDiscount();
        renderCart();
        return;
    }

    const saleRecord = createSaleRecord({
        ...totals,
        discountAuthorizedBy: state.currentDiscountAuthorizedBy
    });

    const updatedProducts = state.products.map(function (product) {
        const cartItem = state.cart.get(product.id);

        if (!cartItem) {
            return { ...product };
        }

        return {
            ...product,
            stock: Math.max(0, product.stock - cartItem.quantity)
        };
    });

    dom.completeSaleButton.disabled = true;

    try {
        const savedSaleId = await saveCompletedSaleTransaction(
            saleRecord,
            updatedProducts
        );

        state.products = updatedProducts;
        state.sales.unshift({
            ...saleRecord,
            id: savedSaleId
        });

        document.dispatchEvent(
            new CustomEvent("sales-changed", {
                detail: {
                    type: "created",
                    sale: {
                        ...saleRecord,
                        id: savedSaleId
                    }
                }
            })
        );

        window.alert(
            "Sale completed successfully.\n\n" +
            (totals.discountAmount > 0
                ? `Subtotal: ${currencyFormatter.format(totals.subtotal)}\n` +
                  `Discount (${totals.discountPercent}%): -${currencyFormatter.format(totals.discountAmount)}\n`
                : "") +
            `Total: ${currencyFormatter.format(saleTotal)}`
        );

        state.currentOrderNumber += 1;
        dom.orderNumberDisplay.textContent = state.currentOrderNumber;
        state.cart.clear();
        clearCurrentDiscount();
        announceProductsChanged();
    } catch (error) {
        console.error("The sale could not be saved:", error);

        window.alert(
            "The sale could not be completed. " +
            "No sale or stock changes have been saved."
        );

        await loadProductsFromDatabase();
        announceProductsChanged();
    } finally {
        renderCart();
    }
}

/* ==================================================
   Initialise Till
================================================== */

export function initialiseTill() {
    dom.clearOrderButton.addEventListener("click", function () {
        if (state.cart.size === 0) {
            return;
        }

        if (window.confirm("Are you sure you want to clear this order?")) {
            clearCart();
        }
    });

    dom.orderOptionsButton.addEventListener("click", openDiscountModal);
    dom.discountForm.addEventListener("submit", applyDiscount);
    dom.removeDiscountButton.addEventListener("click", removeDiscount);
    dom.closeDiscountModalButton.addEventListener("click", closeDiscountModal);
    dom.cancelDiscountButton.addEventListener("click", closeDiscountModal);

    dom.discountModal.addEventListener("click", function (event) {
        if (event.target === dom.discountModal) {
            closeDiscountModal();
        }
    });

    dom.completeSaleButton.addEventListener("click", completeSale);

    dom.closeVariantModalButton.addEventListener("click", closeVariantSelector);
    dom.cancelVariantButton.addEventListener("click", closeVariantSelector);

    dom.variantModal.addEventListener("click", function (event) {
        if (event.target === dom.variantModal) {
            closeVariantSelector();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") {
            return;
        }

        if (!dom.discountModal.hidden) {
            closeDiscountModal();
            return;
        }

        if (!dom.variantModal.hidden) {
            closeVariantSelector();
        }
    });

    renderCart();
}

/* ==================================================
   Refresh Till permissions and availability
================================================== */

export function refreshTillAvailability() {
    const trainingMode = isTrainingUser();

    if (dom.trainingModeBanner) {
        dom.trainingModeBanner.hidden = !trainingMode;
    }

    renderTillProducts();
    renderCart();
}
