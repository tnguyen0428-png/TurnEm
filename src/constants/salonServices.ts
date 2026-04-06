import type { SalonService } from '../types';

export const defaultSalonServices: SalonService[] = [
  // ─── ACRYLICS ───────────────────────────────────────────────
  { id: 'acr-1',  name: 'Full Set Regular',        category: 'Acrylic Full Set', price: 45,  sortOrder: 3,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-2',  name: 'Full Set White Tips',      category: 'Acrylic Full Set', price: 50,  sortOrder: 2,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-3',  name: 'Full Set Gel',             category: 'Acrylic Full Set', price: 50,  sortOrder: 3,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-4',  name: 'Full Set Color Acrylic',   category: 'Acrylic Full Set', price: 55,  sortOrder: 4,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-5',  name: 'Full Set Pink & White',    category: 'Acrylic Full Set', price: 65,  sortOrder: 1,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-6',  name: 'Full Set Ombre',           category: 'Acrylic Full Set', price: 65,  sortOrder: 6,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-7',  name: 'Fill Regular',             category: 'Acrylic Fill',     price: 35,  sortOrder: 4,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-8',  name: 'Fill Gel',                 category: 'Acrylic Fill',     price: 40,  sortOrder: 8,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-9',  name: 'Fill Pink',                category: 'Acrylic Fill',     price: 40,  sortOrder: 9,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-10', name: 'Fill Pink & White',        category: 'Acrylic Fill',     price: 55,  sortOrder: 2,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-11', name: 'Fill Ombre Backfill',      category: 'Acrylic Fill',     price: 55,  sortOrder: 11, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-12', name: 'Gel X',                    category: 'Acrylic Full Set', price: 55,  sortOrder: 12, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'acr-13', name: 'Gel X Fill',               category: 'Acrylic Fill',     price: 50,  sortOrder: 13, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },

  // ─── HEALTHY NAILS ──────────────────────────────────────────
  { id: 'hlt-1',  name: 'Gel Builder',                  category: 'Healthy Nails', price: 50,  sortOrder: 6,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'hlt-2',  name: 'Powder Dip Nails',             category: 'Healthy Nails', price: 50,  sortOrder: 7,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'hlt-3',  name: 'Gel Hard New Set',             category: 'Healthy Nails', price: 60,  sortOrder: 5,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'hlt-4',  name: 'Hard Gel Fill',                category: 'Healthy Nails', price: 50,  sortOrder: 23, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'hlt-5',  name: 'Tips Add On',                  category: 'Healthy Nails', price: 5,   sortOrder: 24, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'hlt-6',  name: 'Dip French',                   category: 'Healthy Nails', price: 10,  sortOrder: 25, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'hlt-7',  name: 'ADD Mani to any Healthy Nails',category: 'Healthy Nails', price: 10,  sortOrder: 26, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },

  // ─── A LA CARTE & ADD-ONS ───────────────────────────────────
  { id: 'ala-1',  name: 'French Polish',                          category: 'A La Carte & Add-Ons', price: 7,   sortOrder: 30, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-2',  name: 'Nail Art',                               category: 'A La Carte & Add-Ons', price: 8,   sortOrder: 31, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-3',  name: 'Multiple Color Polish',                   category: 'A La Carte & Add-Ons', price: 5,   sortOrder: 32, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-4',  name: 'Gel Removal',                            category: 'A La Carte & Add-Ons', price: 5,   sortOrder: 33, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-5',  name: 'Nail Repair',                            category: 'A La Carte & Add-Ons', price: 5,   sortOrder: 34, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-6',  name: 'Coffin / Almond / Duck Feet Shapes',     category: 'A La Carte & Add-Ons', price: 5,   sortOrder: 35, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-7',  name: 'Buff & Shine',                            category: 'A La Carte & Add-Ons', price: 7,   sortOrder: 36, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-8',  name: 'Acrylic & Healthy Nails Removal w/Mani', category: 'A La Carte & Add-Ons', price: 10,  sortOrder: 37, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-9',  name: 'Gel Removal w/ Mani or Pedi',            category: 'A La Carte & Add-Ons', price: 5,   sortOrder: 38, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-10', name: 'Soak Off Acrylic w/ Service',             category: 'A La Carte & Add-Ons', price: 15,  sortOrder: 39, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-11', name: 'Callus Treatment',                        category: 'A La Carte & Add-Ons', price: 10,  sortOrder: 40, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-12', name: 'Polish Change Hand',                      category: 'A La Carte & Add-Ons', price: 15,  sortOrder: 41, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-13', name: 'Polish Change Feet',                      category: 'A La Carte & Add-Ons', price: 15,  sortOrder: 42, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-14', name: 'Gel Polish Hand',                         category: 'A La Carte & Add-Ons', price: 15,  sortOrder: 43, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-15', name: 'Gel Polish Feet',                         category: 'A La Carte & Add-Ons', price: 35,  sortOrder: 44, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-16', name: 'Soak Off Acrylic Only',                   category: 'A La Carte & Add-Ons', price: 20,  sortOrder: 45, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-17', name: 'Extra Massage',                           category: 'A La Carte & Add-Ons', price: 15,  sortOrder: 46, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'ala-18', name: 'Acrylic & Healthy Nails Removal Only',   category: 'A La Carte & Add-Ons', price: 15,  sortOrder: 47, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },

  // ─── MANICURES ──────────────────────────────────────────────
  { id: 'man-1',  name: 'Manicure',                 category: 'Manicures', price: 25,  sortOrder: 13, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-2',  name: 'Manicure Gel',             category: 'Manicures', price: 38,  sortOrder: 12, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },

  // ─── PEDICURES ──────────────────────────────────────────────
  { id: 'man-3',  name: 'Signature Pedicure',       category: 'Pedicures', price: 35,  sortOrder: 52, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-4',  name: 'Signature Pedicure Gel',   category: 'Pedicures', price: 50,  sortOrder: 11, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-5',  name: 'Citrus Pedicure',          category: 'Pedicures', price: 45,  sortOrder: 54, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-6',  name: 'Citrus Pedicure Gel',      category: 'Pedicures', price: 60,  sortOrder: 10, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-7',  name: 'Rose Deluxe Pedicure',     category: 'Pedicures', price: 50,  sortOrder: 56, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-8',  name: 'Rose Deluxe Pedicure Gel', category: 'Pedicures', price: 65,  sortOrder: 9,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-9',  name: 'Full Set Gel Pedicure',    category: 'Pedicures', price: 90,  sortOrder: 58, turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },
  { id: 'man-10', name: 'Full Set Reg Pedicure',    category: 'Pedicures', price: 80,  sortOrder: 8,  turnValue: 1,   duration: 45, isActive: true, isFourthPositionSpecial: false },

  // ─── COMBO ──────────────────────────────────────────────────
  { id: 'cmb-1',  name: 'Mani & Signature Pedi',           category: 'Combo', price: 60,  sortOrder: 60, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-2',  name: 'Mani Gel & Signature Pedi',       category: 'Combo', price: 73,  sortOrder: 61, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-3',  name: 'Mani & Signature Pedi Gel',       category: 'Combo', price: 75,  sortOrder: 62, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-4',  name: 'Mani Gel & Signature Pedi Gel',   category: 'Combo', price: 88,  sortOrder: 63, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-5',  name: 'Citrus Pedi & Mani',              category: 'Combo', price: 70,  sortOrder: 64, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-6',  name: 'Citrus Pedi & Gel Mani',          category: 'Combo', price: 83,  sortOrder: 65, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-7',  name: 'Citrus Gel Pedi & Mani',          category: 'Combo', price: 85,  sortOrder: 66, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-8',  name: 'Citrus Gel Pedi & Gel Mani',      category: 'Combo', price: 98,  sortOrder: 67, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-9',  name: 'Rose Deluxe Pedi & Mani',         category: 'Combo', price: 75,  sortOrder: 68, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-10', name: 'Rose Deluxe Pedi & Gel Mani',     category: 'Combo', price: 88,  sortOrder: 69, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-11', name: 'Rose Deluxe Gel Pedi & Mani',     category: 'Combo', price: 90,  sortOrder: 70, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },
  { id: 'cmb-12', name: 'Rose Deluxe Gel Pedi & Gel Mani', category: 'Combo', price: 103, sortOrder: 71, turnValue: 1.5, duration: 75, isActive: true, isFourthPositionSpecial: false },

  // ─── KIDS SERVICES ──────────────────────────────────────────
  { id: 'kid-1',  name: "Kid's Manicure",            category: 'Kids Services', price: 15, sortOrder: 80, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'kid-2',  name: "Kid's Pedicure",            category: 'Kids Services', price: 25, sortOrder: 15, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'kid-3',  name: "Kid's Mani & Pedi",         category: 'Kids Services', price: 40, sortOrder: 82, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'kid-4',  name: "Kid's Gel Mani",            category: 'Kids Services', price: 25, sortOrder: 83, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'kid-5',  name: "Kid's Gel Pedi",            category: 'Kids Services', price: 35, sortOrder: 14, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'kid-6',  name: "Kid's Gel Polish Hand",     category: 'Kids Services', price: 15, sortOrder: 85, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'kid-7',  name: "Kid's Gel Polish Feet",     category: 'Kids Services', price: 20, sortOrder: 16, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },
  { id: 'kid-8',  name: 'Kids Polish Hands or Feet', category: 'Kids Services', price: 7,  sortOrder: 87, turnValue: 0.5, duration: 30, isActive: true, isFourthPositionSpecial: false },

  // ─── WAX SERVICES ───────────────────────────────────────────
  { id: 'wax-1',  name: 'Lips',        category: 'Wax Services', price: 10, sortOrder: 90, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'wax-2',  name: 'Eyebrows',    category: 'Wax Services', price: 15, sortOrder: 91, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'wax-3',  name: 'Lip & Brows', category: 'Wax Services', price: 25, sortOrder: 92, turnValue: 0.5, duration: 15, isActive: true, isFourthPositionSpecial: false },
  { id: 'wax-4',  name: 'Whole Face',  category: 'Wax Services', price: 45, sortOrder: 93, turnValue: 0.5, duration: 20, isActive: true, isFourthPositionSpecial: false },
];
