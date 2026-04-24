// Create Card
export class CreateCardDto {
  userId!: string;
  cardNumber!: string;
  expireDate!: string;
  phoneNumber!: string;
}

// Confirm Card
export class ConfirmCardDto {
  cardId!: string;
  otp!: string;
  cardName!: string;
  pinfl!: string;
}

// Check Pinfl/Phone
export class CheckCardFieldDto {
  cardId!: string;
  pinfl?: string;
  phone?: string;
}