import {
    WithLengthColumnType,
    WithPrecisionColumnType,
    WithWidthColumnType
} from "typeorm/driver/types/ColumnTypes";
import { DataTypeDefaults } from "typeorm/driver/types/DataTypeDefaults";
import * as TomgUtils from "../Utils";
import EntityInfo from "../models/EntityInfo";
import RelationInfo from "../models/RelationInfo";
import ColumnInfo from "../models/ColumnInfo";
import IConnectionOptions from "../IConnectionOptions";
import IndexInfo from "../models/IndexInfo";
import RelationTempInfo from "../models/RelationTempInfo";

export default abstract class AbstractDriver {
    public abstract standardPort: number;

    public abstract standardSchema: string;

    public abstract standardUser: string;

    public abstract defaultValues: DataTypeDefaults;

    public ColumnTypesWithWidth: WithWidthColumnType[] = [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "bigint"
    ];

    public ColumnTypesWithPrecision: WithPrecisionColumnType[] = [
        "float",
        "double",
        "dec",
        "decimal",
        "numeric",
        "real",
        "double precision",
        "number",
        "datetime",
        "datetime2",
        "datetimeoffset",
        "time",
        "time with time zone",
        "time without time zone",
        "timestamp",
        "timestamp without time zone",
        "timestamp with time zone",
        "timestamp with local time zone"
    ];

    public ColumnTypesWithLength: WithLengthColumnType[] = [
        "character varying",
        "varying character",
        "nvarchar",
        "character",
        "native character",
        "varchar",
        "char",
        "nchar",
        "varchar2",
        "nvarchar2",
        "raw",
        "binary",
        "varbinary"
    ];

    public abstract GetAllTablesQuery: (
        schema: string,
        dbNames: string
    ) => Promise<
        {
            TABLE_SCHEMA: string;
            TABLE_NAME: string;
            DB_NAME: string;
        }[]
    >;

    public static FindManyToManyRelations(dbModel: EntityInfo[]) {
        let retval = dbModel;
        const manyToManyEntities = retval.filter(
            entity =>
                entity.Columns.filter(column => {
                    return (
                        column.relations.length === 1 &&
                        !column.relations[0].isOneToMany &&
                        column.relations[0].isOwner
                    );
                }).length === entity.Columns.length
        );
        manyToManyEntities.forEach(entity => {
            let relations: RelationInfo[] = [];
            relations = entity.Columns.reduce(
                (prev: RelationInfo[], curr) => prev.concat(curr.relations),
                relations
            );
            const namesOfRelatedTables = relations
                .map(v => v.relatedTable)
                .filter((v, i, s) => s.indexOf(v) === i);
            const [
                firstRelatedTable,
                secondRelatedTable
            ] = namesOfRelatedTables;

            if (namesOfRelatedTables.length === 2) {
                const relatedTable1 = retval.find(
                    v => v.tsEntityName === firstRelatedTable
                )!;
                relatedTable1.Columns = relatedTable1.Columns.filter(
                    v =>
                        !v.tsName
                            .toLowerCase()
                            .startsWith(entity.tsEntityName.toLowerCase())
                );
                const relatedTable2 = retval.find(
                    v => v.tsEntityName === namesOfRelatedTables[1]
                )!;
                relatedTable2.Columns = relatedTable2.Columns.filter(
                    v =>
                        !v.tsName
                            .toLowerCase()
                            .startsWith(entity.tsEntityName.toLowerCase())
                );
                retval = retval.filter(ent => {
                    return ent.tsEntityName !== entity.tsEntityName;
                });

                const column1 = new ColumnInfo();
                column1.tsName = secondRelatedTable;
                column1.options.name = entity.sqlEntityName;

                const col1Rel = new RelationInfo();
                col1Rel.relatedTable = secondRelatedTable;
                col1Rel.relatedColumn = secondRelatedTable;

                col1Rel.relationType = "ManyToMany";
                col1Rel.isOwner = true;
                col1Rel.ownerColumn = firstRelatedTable;

                column1.relations.push(col1Rel);
                relatedTable1.Columns.push(column1);

                const column2 = new ColumnInfo();
                column2.tsName = firstRelatedTable;

                const col2Rel = new RelationInfo();
                col2Rel.relatedTable = firstRelatedTable;
                col2Rel.relatedColumn = secondRelatedTable;

                col2Rel.relationType = "ManyToMany";
                col2Rel.isOwner = false;
                column2.relations.push(col2Rel);
                relatedTable2.Columns.push(column2);
            }
        });
        return retval;
    }

    public async GetDataFromServer(
        connectionOptons: IConnectionOptions
    ): Promise<EntityInfo[]> {
        let dbModel = [] as EntityInfo[];
        await this.ConnectToServer(connectionOptons);
        const sqlEscapedSchema = AbstractDriver.escapeCommaSeparatedList(
            connectionOptons.schemaName
        );
        dbModel = await this.GetAllTables(
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        await this.GetCoulmnsFromEntity(
            dbModel,
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        await this.GetIndexesFromEntity(
            dbModel,
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        dbModel = await this.GetRelations(
            dbModel,
            sqlEscapedSchema,
            connectionOptons.databaseName
        );
        await this.DisconnectFromServer();
        dbModel = AbstractDriver.FindManyToManyRelations(dbModel);
        AbstractDriver.FindPrimaryColumnsFromIndexes(dbModel);
        return dbModel;
    }

    public abstract async ConnectToServer(connectionOptons: IConnectionOptions);

    public async GetAllTables(
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]> {
        const response = await this.GetAllTablesQuery(schema, dbNames);
        const ret: EntityInfo[] = [] as EntityInfo[];
        response.forEach(val => {
            const ent: EntityInfo = new EntityInfo();
            ent.tsEntityName = val.TABLE_NAME;
            ent.sqlEntityName = val.TABLE_NAME;
            ent.Schema = val.TABLE_SCHEMA;
            ent.Columns = [] as ColumnInfo[];
            ent.Indexes = [] as IndexInfo[];
            ent.Database = dbNames.includes(",") ? val.DB_NAME : "";
            ret.push(ent);
        });
        return ret;
    }

    public static GetRelationsFromRelationTempInfo(
        relationsTemp: RelationTempInfo[],
        entities: EntityInfo[]
    ) {
        relationsTemp.forEach(relationTmp => {
            const ownerEntity = entities.find(
                entitity => entitity.tsEntityName === relationTmp.ownerTable
            );
            if (!ownerEntity) {
                TomgUtils.LogError(
                    `Relation between tables ${relationTmp.ownerTable} and ${relationTmp.referencedTable} didn't found entity model ${relationTmp.ownerTable}.`
                );
                return;
            }
            const referencedEntity = entities.find(
                entitity =>
                    entitity.tsEntityName === relationTmp.referencedTable
            );
            if (!referencedEntity) {
                TomgUtils.LogError(
                    `Relation between tables ${relationTmp.ownerTable} and ${relationTmp.referencedTable} didn't found entity model ${relationTmp.referencedTable}.`
                );
                return;
            }
            for (
                let relationColumnIndex = 0;
                relationColumnIndex < relationTmp.ownerColumnsNames.length;
                relationColumnIndex++
            ) {
                const ownerColumn = ownerEntity.Columns.find(
                    column =>
                        column.tsName ===
                        relationTmp.ownerColumnsNames[relationColumnIndex]
                );
                if (!ownerColumn) {
                    TomgUtils.LogError(
                        `Relation between tables ${relationTmp.ownerTable} and ${relationTmp.referencedTable} didn't found entity column ${relationTmp.ownerTable}.${ownerColumn}.`
                    );
                    return;
                }
                const relatedColumn = referencedEntity.Columns.find(
                    column =>
                        column.tsName ===
                        relationTmp.referencedColumnsNames[relationColumnIndex]
                );
                if (!relatedColumn) {
                    TomgUtils.LogError(
                        `Relation between tables ${relationTmp.ownerTable} and ${relationTmp.referencedTable} didn't found entity column ${relationTmp.referencedTable}.${relatedColumn}.`
                    );
                    return;
                }
                let isOneToMany: boolean;
                isOneToMany = false;
                const index = ownerEntity.Indexes.find(
                    ind =>
                        ind.isUnique &&
                        ind.columns.length === 1 &&
                        ind.columns[0].name === ownerColumn!.tsName
                );
                isOneToMany = !index;

                const ownerRelation = new RelationInfo();
                ownerRelation.actionOnDelete = relationTmp.actionOnDelete;
                ownerRelation.actionOnUpdate = relationTmp.actionOnUpdate;
                ownerRelation.isOwner = true;
                ownerRelation.relatedColumn = relatedColumn.tsName.toLowerCase();
                ownerRelation.relatedTable = relationTmp.referencedTable;
                ownerRelation.ownerTable = relationTmp.ownerTable;
                ownerRelation.relationType = isOneToMany
                    ? "ManyToOne"
                    : "OneToOne";

                let columnName = ownerEntity.tsEntityName;
                if (
                    referencedEntity.Columns.some(v => v.tsName === columnName)
                ) {
                    columnName += "_";
                    for (let i = 2; i <= referencedEntity.Columns.length; i++) {
                        columnName =
                            columnName.substring(
                                0,
                                columnName.length - i.toString().length
                            ) + i.toString();
                        if (
                            referencedEntity.Columns.every(
                                v => v.tsName !== columnName
                            )
                        ) {
                            break;
                        }
                    }
                }

                ownerRelation.ownerColumn = columnName;
                ownerColumn.relations.push(ownerRelation);
                if (isOneToMany) {
                    const col = new ColumnInfo();
                    col.tsName = columnName;
                    const referencedRelation = new RelationInfo();
                    col.relations.push(referencedRelation);
                    referencedRelation.actionOnDelete =
                        relationTmp.actionOnDelete;
                    referencedRelation.actionOnUpdate =
                        relationTmp.actionOnUpdate;
                    referencedRelation.isOwner = false;
                    referencedRelation.relatedColumn = ownerColumn.tsName;
                    referencedRelation.relatedTable = relationTmp.ownerTable;
                    referencedRelation.ownerTable = relationTmp.referencedTable;
                    referencedRelation.ownerColumn = relatedColumn.tsName;
                    referencedRelation.relationType = "OneToMany";
                    referencedEntity.Columns.push(col);
                } else {
                    const col = new ColumnInfo();
                    col.tsName = columnName;
                    const referencedRelation = new RelationInfo();
                    col.relations.push(referencedRelation);
                    referencedRelation.actionOnDelete =
                        relationTmp.actionOnDelete;
                    referencedRelation.actionOnUpdate =
                        relationTmp.actionOnUpdate;
                    referencedRelation.isOwner = false;
                    referencedRelation.relatedColumn = ownerColumn.tsName;
                    referencedRelation.relatedTable = relationTmp.ownerTable;
                    referencedRelation.ownerTable = relationTmp.referencedTable;
                    referencedRelation.ownerColumn = relatedColumn.tsName;
                    referencedRelation.relationType = "OneToOne";
                    referencedEntity.Columns.push(col);
                }
            }
        });
        return entities;
    }

    public abstract async GetCoulmnsFromEntity(
        entities: EntityInfo[],
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]>;

    public abstract async GetIndexesFromEntity(
        entities: EntityInfo[],
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]>;

    public abstract async GetRelations(
        entities: EntityInfo[],
        schema: string,
        dbNames: string
    ): Promise<EntityInfo[]>;

    public static FindPrimaryColumnsFromIndexes(dbModel: EntityInfo[]) {
        dbModel.forEach(entity => {
            const primaryIndex = entity.Indexes.find(v => v.isPrimaryKey);
            entity.Columns.filter(
                col =>
                    primaryIndex &&
                    primaryIndex.columns.some(
                        cIndex => cIndex.name === col.tsName
                    )
            ).forEach(col => {
                // eslint-disable-next-line no-param-reassign
                col.options.primary = true;
            });
            if (
                !entity.Columns.some(v => {
                    return !!v.options.primary;
                })
            ) {
                TomgUtils.LogError(
                    `Table ${entity.tsEntityName} has no PK.`,
                    false
                );
            }
        });
    }

    public abstract async DisconnectFromServer();

    public abstract async CreateDB(dbName: string);

    public abstract async DropDB(dbName: string);

    public abstract async UseDB(dbName: string);

    public abstract async CheckIfDBExists(dbName: string): Promise<boolean>;

    // TODO: change name
    protected static escapeCommaSeparatedList(commaSeparatedList: string) {
        return `'${commaSeparatedList.split(",").join("','")}'`;
    }
}
