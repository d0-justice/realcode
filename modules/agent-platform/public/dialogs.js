export function createDialogs({ $, state, api, toast }) {
function showPermission(data) {
  state.pendingPermission = data;
  $("#permission-description").textContent = data.toolCall?.title || "RealCode 请求执行一项操作。";
  const choices = $("#permission-options");
  choices.replaceChildren();
  for (const option of data.options || []) {
    const button = document.createElement("button");
    button.textContent = option.name;
    button.addEventListener("click", () => answerPermission(option.optionId));
    choices.append(button);
  }
  $("#permission-modal").hidden = false;
}

async function answerPermission(optionId) {
  const requestId = state.pendingPermission?.requestId;
  if (!requestId) return;
  try {
    await api("/api/permission", { requestId, optionId });
    state.pendingPermission = null;
    $("#permission-modal").hidden = true;
  } catch (error) { toast(error.message); }
}

function showQuestion(data) {
  state.pendingQuestion = data;
  $("#question-description").textContent = data.message;
  const fields = $("#question-fields");
  fields.replaceChildren();
  for (const [name, schema] of Object.entries(data.schema?.properties ?? {})) {
    const label = document.createElement("label");
    label.textContent = schema.title || name;
    label.dataset.field = name;
    let input;
    if (schema.type === "array") {
      input = document.createElement("div");
      input.className = "question-checkboxes";
      const choices = schema.items?.enum?.map((value) => ({ value, title: value })) ?? schema.items?.anyOf?.map((item) => ({ value: item.const, title: item.title })) ?? [];
      for (const choice of choices) {
        const choiceLabel = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = name;
        checkbox.value = choice.value;
        checkbox.checked = schema.default?.includes(choice.value) === true;
        choiceLabel.append(checkbox, document.createTextNode(choice.title));
        input.append(choiceLabel);
      }
    } else if (schema.type === "string" && (schema.enum?.length || schema.oneOf?.length)) {
      input = document.createElement("select");
      const choices = schema.enum?.length ? schema.enum.map((value) => ({ value, title: value })) : (schema.oneOf ?? []).map((item) => ({ value: item.const, title: item.title }));
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.title;
        input.append(option);
      }
    } else {
      input = document.createElement("input");
      input.type = schema.type === "boolean" ? "checkbox" : ["integer", "number"].includes(schema.type) ? "number" : schema.format === "email" ? "email" : schema.format === "date" ? "date" : "text";
      if (schema.type === "integer") input.step = "1";
      if (data.schema?.required?.includes(name)) input.required = true;
    }
    if (schema.type !== "array") input.name = name;
    label.append(input);
    fields.append(label);
  }
  $("#question-modal").hidden = false;
}

async function answerQuestion(content) {
  const requestId = state.pendingQuestion?.requestId;
  if (!requestId) return;
  try {
    await api("/api/question", { requestId, content });
    state.pendingQuestion = null;
    $("#question-modal").hidden = true;
  } catch (error) { toast(error.message); }
}


return { showPermission, answerPermission, showQuestion, answerQuestion };
}
