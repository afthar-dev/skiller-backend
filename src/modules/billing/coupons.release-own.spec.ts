import { CouponsService } from "./coupons.service";

/** MON-9: a buyer's own abandoned (unpaid) reservation of a coupon must not block the same buyer's next checkout. */
describe("CouponsService.releaseOwnReservations", () => {
  it("releases only this buyer's RESERVED uses of this coupon whose order is still CREATED", async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const orderFind = jest.fn(async () => [{ id: "O1" }]);
    const tx = {
      coupon: { findUnique: async () => ({ id: "C1" }) },
      couponRedemption: { findMany: jest.fn(async () => [{ orderId: "O1" }, { orderId: "O2" }]), updateMany },
      order: { findMany: orderFind },
    };
    const svc = new CouponsService({} as never, {} as never, {} as never);
    await svc.releaseOwnReservations(tx as never, "launch30", "buyer1");
    expect(tx.couponRedemption.findMany).toHaveBeenCalledWith({ where: { couponId: "C1", userId: "buyer1", status: "RESERVED" }, select: { orderId: true } });
    expect(orderFind).toHaveBeenCalledWith({ where: { id: { in: ["O1", "O2"] }, buyerId: "buyer1", status: "CREATED" }, select: { id: true } });
    expect(updateMany).toHaveBeenCalledWith({ where: { orderId: { in: ["O1"] }, status: "RESERVED" }, data: { status: "RELEASED" } });
  });
  it("does nothing for an unknown code", async () => {
    const updateMany = jest.fn();
    const tx = { coupon: { findUnique: async () => null }, couponRedemption: { updateMany } };
    await new CouponsService({} as never, {} as never, {} as never).releaseOwnReservations(tx as never, "nope", "b");
    expect(updateMany).not.toHaveBeenCalled();
  });
});
