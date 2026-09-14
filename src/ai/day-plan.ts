export interface DayPlanItem {
  placeId: string;
  note: string;
}

export interface GeneratedDayPlan {
  summary: string;
  items: DayPlanItem[];
}
