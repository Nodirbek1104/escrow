import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Profile photos: adds a nullable avatarUrl column to the user table. Existing
 * rows keep NULL (UI shows initials). Hand-written (not generated) so it only
 * touches this one column regardless of other pending entity changes.
 */
export class AddUserAvatar1780600000000 implements MigrationInterface {
    name = 'AddUserAvatar1780600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" ADD "avatarUrl" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "avatarUrl"`);
    }
}
