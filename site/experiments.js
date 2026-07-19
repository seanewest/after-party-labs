const effectLabels = Object.freeze({
  read: 'Reads tenant data',
  write: 'Changes tenant data',
});

const stateLabels = Object.freeze({
  idle: 'Ready',
  pending: 'Running',
  success: 'Succeeded',
  blocked: 'Blocked',
  failure: 'Failed',
});

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value, label) {
  if (value === undefined) {
    return undefined;
  }
  return requiredText(value, label);
}

function normalizeRequirement(requirement) {
  if (!requirement || typeof requirement !== 'object') {
    throw new TypeError('Experiment requirement must identify a permission or role.');
  }
  if (!['permission', 'role'].includes(requirement.kind)) {
    throw new TypeError('Experiment requirement kind must be permission or role.');
  }
  return Object.freeze({
    kind: requirement.kind,
    label: requiredText(requirement.label, 'Experiment requirement label'),
  });
}

function normalizeAvailability(availability, context) {
  const evaluated = typeof availability === 'function' ? availability(context) : availability;
  if (evaluated === undefined || evaluated === true) {
    return Object.freeze({ available: true });
  }
  if (evaluated === false) {
    return Object.freeze({
      available: false,
      reason: 'This experiment is not available in the current tenant.',
    });
  }
  if (!evaluated || typeof evaluated !== 'object' || typeof evaluated.available !== 'boolean') {
    throw new TypeError('Experiment availability must resolve to a boolean or availability object.');
  }
  return Object.freeze({
    available: evaluated.available,
    reason: evaluated.available
      ? undefined
      : requiredText(evaluated.reason, 'Blocked availability reason'),
  });
}

function normalizeDetails(details) {
  if (details === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(details)) {
    throw new TypeError('Experiment result details must be an array.');
  }
  return Object.freeze(
    details.map((detail) => {
      if (!detail || typeof detail !== 'object') {
        throw new TypeError('Each experiment result detail must have a label and value.');
      }
      return Object.freeze({
        label: requiredText(detail.label, 'Experiment result detail label'),
        value: requiredText(detail.value, 'Experiment result detail value'),
      });
    }),
  );
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('Experiment action must return a result object.');
  }
  return Object.freeze({
    summary: requiredText(result.summary, 'Experiment result summary'),
    tenantId: optionalText(result.tenantId, 'Experiment result tenant ID'),
    version: optionalText(result.version, 'Experiment result version'),
    details: normalizeDetails(result.details),
  });
}

function errorMessage(error) {
  return typeof error?.message === 'string' && error.message.trim() !== ''
    ? error.message.trim()
    : 'The experiment did not complete.';
}

export function defineExperimentCard(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('Experiment card definition is required.');
  }
  const id = requiredText(definition.id, 'Experiment ID');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new TypeError('Experiment ID must use lowercase kebab-case.');
  }
  if (!Object.hasOwn(effectLabels, definition.effect)) {
    throw new TypeError('Experiment effect must be read or write.');
  }
  if (typeof definition.action !== 'function') {
    throw new TypeError('Experiment action must be a function.');
  }

  return Object.freeze({
    id,
    title: requiredText(definition.title, 'Experiment title'),
    description: requiredText(definition.description, 'Experiment description'),
    requirement: normalizeRequirement(definition.requirement),
    effect: definition.effect,
    availability: definition.availability ?? true,
    actionLabel: optionalText(definition.actionLabel, 'Experiment action label') ?? 'Run experiment',
    action: definition.action,
    errorGuidance: requiredText(definition.errorGuidance, 'Experiment error guidance'),
  });
}

export function describeExperimentCard(card, state) {
  if (!Object.hasOwn(stateLabels, state.status)) {
    throw new TypeError(`Unknown experiment state: ${state.status}`);
  }
  const metadata = [];
  if (state.result?.tenantId) {
    metadata.push(Object.freeze({ label: 'Tenant ID', value: state.result.tenantId }));
  }
  if (state.result?.version) {
    metadata.push(Object.freeze({ label: 'Deployed version', value: state.result.version }));
  }
  metadata.push(...(state.result?.details ?? []));

  return Object.freeze({
    id: card.id,
    title: card.title,
    description: card.description,
    requirement: `${card.requirement.kind === 'permission' ? 'Permission' : 'Role'}: ${card.requirement.label}`,
    effect: card.effect,
    effectLabel: effectLabels[card.effect],
    status: state.status,
    statusLabel: stateLabels[state.status],
    statusMessage:
      state.status === 'idle'
        ? 'Review the effect and requirement before running this experiment.'
        : state.status === 'pending'
          ? 'Keep this page open while After Party completes the operation.'
          : state.status === 'blocked'
            ? state.reason
            : state.status === 'failure'
              ? state.error
              : state.result.summary,
    guidance: ['blocked', 'failure'].includes(state.status) ? card.errorGuidance : undefined,
    actionLabel: card.actionLabel,
    actionDisabled: ['pending', 'blocked'].includes(state.status),
    metadata: Object.freeze(metadata),
  });
}

export function createExperimentCardController({ card, context = {}, render = () => {} }) {
  if (!card || typeof card !== 'object') {
    throw new TypeError('A defined experiment card is required.');
  }
  if (typeof render !== 'function') {
    throw new TypeError('Experiment render callback must be a function.');
  }

  let state;
  let pending;

  function publish(nextState) {
    state = Object.freeze(nextState);
    render(describeExperimentCard(card, state));
    return state;
  }

  function prepare() {
    const availability = normalizeAvailability(card.availability, context);
    return availability.available
      ? publish({ status: 'idle' })
      : publish({ status: 'blocked', reason: availability.reason });
  }

  async function run() {
    if (pending) {
      return pending;
    }
    const availability = normalizeAvailability(card.availability, context);
    if (!availability.available) {
      return publish({ status: 'blocked', reason: availability.reason });
    }

    publish({ status: 'pending' });
    pending = (async () => {
      try {
        const result = normalizeResult(await card.action(context));
        return publish({ status: 'success', result });
      } catch (error) {
        return publish({ status: 'failure', error: errorMessage(error) });
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  prepare();
  return Object.freeze({
    getState: () => state,
    prepare,
    run,
  });
}

function addTextElement(document, parent, tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

export function mountExperimentCard({ document, container, card, context = {} }) {
  if (!document?.createElement || !container?.append) {
    throw new TypeError('Experiment cards require a document and container.');
  }

  const article = document.createElement('article');
  article.className = 'experiment-card';
  article.dataset.experimentId = card.id;
  article.dataset.effect = card.effect;

  const heading = addTextElement(document, article, 'h3', 'experiment-title', card.title);
  heading.id = `experiment-${card.id}`;
  article.setAttribute('aria-labelledby', heading.id);
  const badges = document.createElement('div');
  badges.className = 'experiment-badges';
  const effect = addTextElement(document, badges, 'span', 'experiment-badge', effectLabels[card.effect]);
  effect.dataset.effect = card.effect;
  addTextElement(
    document,
    badges,
    'span',
    'experiment-badge',
    `${card.requirement.kind === 'permission' ? 'Permission' : 'Role'}: ${card.requirement.label}`,
  );
  article.append(badges);
  addTextElement(document, article, 'p', 'experiment-description', card.description);

  const action = addTextElement(document, article, 'button', 'button primary experiment-action', card.actionLabel);
  action.type = 'button';

  const status = document.createElement('div');
  status.className = 'experiment-status notice';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const statusLabel = addTextElement(document, status, 'strong', 'experiment-status-label', '');
  const statusMessage = addTextElement(document, status, 'p', 'experiment-status-message', '');
  article.append(status);

  const metadata = document.createElement('dl');
  metadata.className = 'experiment-result';
  metadata.hidden = true;
  article.append(metadata);
  const guidance = addTextElement(document, article, 'p', 'experiment-guidance', '');
  guidance.hidden = true;

  const controller = createExperimentCardController({
    card,
    context,
    render(viewModel) {
      article.dataset.state = viewModel.status;
      status.dataset.kind =
        viewModel.status === 'success'
          ? 'success'
          : ['blocked', 'failure'].includes(viewModel.status)
            ? 'error'
            : 'neutral';
      statusLabel.textContent = viewModel.statusLabel;
      statusMessage.textContent = viewModel.statusMessage;
      action.disabled = viewModel.actionDisabled;
      action.textContent = viewModel.status === 'pending' ? 'Running…' : viewModel.actionLabel;
      guidance.hidden = !viewModel.guidance;
      guidance.textContent = viewModel.guidance ?? '';
      metadata.replaceChildren(
        ...viewModel.metadata.flatMap((item) => {
          const term = document.createElement('dt');
          term.textContent = item.label;
          const value = document.createElement('dd');
          value.textContent = item.value;
          return [term, value];
        }),
      );
      metadata.hidden = viewModel.metadata.length === 0;
    },
  });
  action.addEventListener('click', () => controller.run());
  container.append(article);
  return controller;
}

export function mountExperimentCards({ document, container, cards, context = {} }) {
  if (!Array.isArray(cards)) {
    throw new TypeError('Experiment cards must be an array.');
  }
  container.replaceChildren();
  const controllers = cards.map((card) =>
    mountExperimentCard({ document, container, card, context }),
  );
  return Object.freeze(controllers);
}
