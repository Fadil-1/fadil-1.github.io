(() => {
  const form = document.getElementById("contactForm");
  const fields = Array.from(form.querySelectorAll("[required]"));
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById("contact-status");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (button.disabled) {
      return;
    }

    const blankField = fields.find((field) => !field.value.trim());
    if (blankField) {
      blankField.value = "";
      blankField.reportValidity();
      return;
    }

    const data = new FormData(form);
    button.disabled = true;
    fields.forEach((field) => { field.readOnly = true; });
    status.textContent = "Sending…";

    try {
      const response = await fetch(form.action, {
        method: form.method,
        headers: { Accept: "application/json" },
        body: data,
      });

      if (!response.ok) {
        status.textContent = "Your message couldn’t be sent. Please check your details and try again.";
        return;
      }

      form.reset();
      status.textContent = "Message sent. Thanks for getting in touch.";
    } catch {
      status.textContent = "Couldn’t confirm delivery. Please try again.";
    } finally {
      fields.forEach((field) => { field.readOnly = false; });
      button.disabled = false;
    }
  });
})();
