#!/usr/bin/env python3
"""
Titanic Survival Prediction — Baseline RandomForest Model
Reads train.csv and test.csv from the same directory,
trains a classifier, and writes submission.csv.
"""
import os
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder

BASE = os.path.dirname(os.path.abspath(__file__))

def preprocess(df):
    df = df.copy()
    df['Age']      = df['Age'].fillna(df['Age'].median())
    df['Fare']     = df['Fare'].fillna(df['Fare'].median())
    df['Embarked'] = df['Embarked'].fillna('S')
    df['Sex']      = LabelEncoder().fit_transform(df['Sex'])
    df['Embarked'] = LabelEncoder().fit_transform(df['Embarked'])
    return df

def main():
    print("📂 Loading Titanic dataset…")
    train = preprocess(pd.read_csv(os.path.join(BASE, 'train.csv')))
    test  = preprocess(pd.read_csv(os.path.join(BASE, 'test.csv')))

    features = ['Pclass', 'Sex', 'Age', 'SibSp', 'Parch', 'Fare', 'Embarked']
    X_train, y_train = train[features], train['Survived']
    X_test  = test[features]
    passenger_ids = pd.read_csv(os.path.join(BASE, 'test.csv'))['PassengerId']

    print("🌲 Training RandomForest classifier (200 trees, max_depth=7)…")
    clf = RandomForestClassifier(n_estimators=200, max_depth=7, random_state=42)
    clf.fit(X_train, y_train)
    print(f"✅ Training accuracy: {clf.score(X_train, y_train):.4f}")

    print("🔮 Generating predictions…")
    preds = clf.predict(X_test)

    out_path = os.path.join(BASE, 'submission.csv')
    pd.DataFrame({'PassengerId': passenger_ids, 'Survived': preds}).to_csv(out_path, index=False)
    print(f"💾 Submission saved → {out_path}")
    print(f"   Rows: {len(preds)}, Survival rate: {preds.mean():.2%}")

if __name__ == '__main__':
    main()
