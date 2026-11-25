import { REFUND_WINDOW_DAYS } from "../../common/refund-window";
import { parseSettingWrite } from "./settings.registry";

describe("settings write validation", () => {
  it("MON-5: hold_days below the refund window is rejected, the window itself and above are accepted", () => {
    expect(() => parseSettingWrite("hold_days", REFUND_WINDOW_DAYS - 1)).toThrow();
    expect(() => parseSettingWrite("hold_days", 0)).toThrow();
    expect(parseSettingWrite("hold_days", REFUND_WINDOW_DAYS)).toBe(REFUND_WINDOW_DAYS);
    expect(parseSettingWrite("hold_days", 90)).toBe(90);
    expect(() => parseSettingWrite("hold_days", 91)).toThrow();
  });
  it("other settings keep their own schema", () => {
    expect(parseSettingWrite("tds_bps", 0)).toBe(0);
    expect(() => parseSettingWrite("tds_bps", -1)).toThrow();
  });
});
