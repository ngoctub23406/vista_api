// SLA xử lý đơn: thời gian tối đa cho từng bước của Staff
const SLA_CONFIRM_MS = 2 * 60 * 60 * 1000; // Chờ xác nhận quá 2 giờ
const SLA_HAND_OVER_MS = 24 * 60 * 60 * 1000; // Đã xác nhận quá 24 giờ chưa bàn giao

const SLA_STAGES = {
  CONFIRM: "confirm",
  HAND_OVER: "hand_over",
};

/**
 * Các stage aggregate tính thêm cho mỗi đơn:
 * - Display_status: trạng thái hiển thị (giống getDisplayStatus ở controller)
 * - Sla_stage: bước Staff đang phải làm ("confirm" | "hand_over" | null)
 * - Sla_deadline: hạn của bước đó
 * - Is_overdue: đã quá hạn hay chưa
 */
function buildSlaStages(now = new Date()) {
  return [
    { $addFields: { _events: { $ifNull: ["$Status_history", []] } } },
    {
      $addFields: {
        _isConfirmed: { $in: ["confirmed", "$_events.Event"] },
        _isHandedOver: { $in: ["handed_over", "$_events.Event"] },
        _confirmedAt: {
          $min: {
            $map: {
              input: { $filter: { input: "$_events", cond: { $eq: ["$$this.Event", "confirmed"] } } },
              in: "$$this.Created_at",
            },
          },
        },
      },
    },
    {
      $addFields: {
        Display_status: {
          $switch: {
            branches: [
              { case: { $eq: ["$Status", "cancelled"] }, then: "cancelled" },
              { case: { $eq: ["$Status", "returning"] }, then: "returning" },
              { case: { $in: ["$Status", ["delivered", "review"]] }, then: "completed" },
              { case: { $in: ["$Status", ["shipping", "delivering"]] }, then: "shipping" },
              { case: "$_isConfirmed", then: "processing" },
            ],
            default: "pending_confirmation",
          },
        },
      },
    },
    {
      $addFields: {
        Sla_stage: {
          $switch: {
            branches: [
              { case: { $eq: ["$Display_status", "pending_confirmation"] }, then: SLA_STAGES.CONFIRM },
              {
                case: { $and: [{ $eq: ["$Display_status", "processing"] }, { $not: ["$_isHandedOver"] }] },
                then: SLA_STAGES.HAND_OVER,
              },
            ],
            default: null,
          },
        },
      },
    },
    {
      $addFields: {
        Sla_deadline: {
          $switch: {
            branches: [
              {
                case: { $eq: ["$Sla_stage", SLA_STAGES.CONFIRM] },
                then: { $add: [{ $ifNull: ["$Processing_started_at", "$Created_at"] }, SLA_CONFIRM_MS] },
              },
              {
                case: { $eq: ["$Sla_stage", SLA_STAGES.HAND_OVER] },
                then: {
                  $add: [{ $ifNull: ["$_confirmedAt", "$Processing_started_at", "$Created_at"] }, SLA_HAND_OVER_MS],
                },
              },
            ],
            default: null,
          },
        },
      },
    },
    {
      $addFields: {
        Is_overdue: { $and: [{ $ne: ["$Sla_deadline", null] }, { $lt: ["$Sla_deadline", now] }] },
      },
    },
    { $project: { _events: 0, _isConfirmed: 0, _isHandedOver: 0, _confirmedAt: 0 } },
  ];
}

// Tính SLA cho 1 đơn ở phía JS (dùng cho màn chi tiết)
function computeSla(order, displayStatus, now = Date.now()) {
  const history = Array.isArray(order?.Status_history) ? order.Status_history : [];
  const confirmedAt = history.find((item) => item.Event === "confirmed")?.Created_at;
  const isHandedOver = history.some((item) => item.Event === "handed_over");

  let stage = null;
  let deadline = null;

  if (displayStatus === "pending_confirmation") {
    stage = SLA_STAGES.CONFIRM;
    deadline = new Date(new Date(order.Processing_started_at || order.Created_at).getTime() + SLA_CONFIRM_MS);
  } else if (displayStatus === "processing" && !isHandedOver) {
    stage = SLA_STAGES.HAND_OVER;
    const start = confirmedAt || order.Processing_started_at || order.Created_at;
    deadline = new Date(new Date(start).getTime() + SLA_HAND_OVER_MS);
  }

  const validDeadline = deadline && !Number.isNaN(deadline.getTime()) ? deadline : null;

  return {
    Sla_stage: stage,
    Sla_deadline: validDeadline,
    Is_overdue: Boolean(validDeadline && validDeadline.getTime() < now),
  };
}

module.exports = {
  SLA_CONFIRM_MS,
  SLA_HAND_OVER_MS,
  SLA_STAGES,
  buildSlaStages,
  computeSla,
};
