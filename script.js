// Copy button for the install command
document.querySelectorAll(".copy").forEach(btn => {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = "copied";
    } catch {
      btn.textContent = "failed";
    }
    setTimeout(() => (btn.textContent = "copy"), 1400);
  });
});
